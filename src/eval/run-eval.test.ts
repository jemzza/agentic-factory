import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunTaskResult } from "../pipeline/run-task.js";
import type { RunReport, RunStatus } from "../schemas/report.js";
import type { EvalMeta, TaskSpec } from "../schemas/task.js";
import type { HiddenTestResult } from "./hidden-tests.js";
import { parseVitestJson } from "./hidden-tests.js";
import { classify, computeMetrics, runEval, type EvalTaskResult } from "./run-eval.js";

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "factory-eval-test-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const hidden = (passed: boolean, extra: Partial<HiddenTestResult> = {}): HiddenTestResult => ({
  passed,
  exitCode: passed ? 0 : 1,
  timedOut: false,
  total: 4,
  failed: passed ? 0 : 1,
  durationMs: 10,
  outputTail: passed ? "" : "✗ x: expected 409",
  ...extra,
});

describe("classify", () => {
  it("turns a success claim into verified or false_success using hidden tests", () => {
    expect(classify("success", "implemented", hidden(true))).toEqual({
      outcome: "verified",
      correct: true,
    });
    expect(classify("success", "implemented", hidden(false))).toEqual({
      outcome: "false_success",
      correct: false,
    });
  });

  it("never counts a success as verified when the hidden tests could not run", () => {
    expect(classify("success", "implemented", null).outcome).toBe("hidden_error");
    expect(
      classify("success", "implemented", hidden(true, { infraError: "docker down" })).outcome,
    ).toBe("hidden_error");
  });

  it("counts needs_clarification as correct only for contradictory tasks", () => {
    expect(classify("needs_clarification", "needs_clarification", null)).toEqual({
      outcome: "needs_clarification",
      correct: true,
    });
    expect(classify("needs_clarification", "implemented", null).correct).toBe(false);
  });

  it("does not count implementing a contradictory task as correct", () => {
    expect(classify("success", "needs_clarification", hidden(true))).toEqual({
      outcome: "verified",
      correct: false,
    });
  });

  it.each(["gate_failed", "review_rejected", "timeout", "budget_exceeded", "error"] as const)(
    "keeps %s as the outcome",
    (status) => {
      expect(classify(status, "implemented", null)).toEqual({ outcome: status, correct: false });
    },
  );
});

function result(overrides: Partial<EvalTaskResult>): EvalTaskResult {
  return {
    taskId: "t",
    title: "T",
    difficulty: "simple",
    expected: "implemented",
    status: "success",
    outcome: "verified",
    correct: true,
    message: "",
    fixCycles: 0,
    reachedDeveloper: true,
    durationMs: 10_000,
    costUsd: 0.5,
    unknownCostSteps: 0,
    hidden: null,
    hiddenLeaks: [],
    reportPath: null,
    ...overrides,
  };
}

describe("computeMetrics", () => {
  it("computes rates, averages and totals", () => {
    const m = computeMetrics([
      result({ fixCycles: 1 }),
      result({ outcome: "false_success", correct: false, fixCycles: 2 }),
      result({ status: "gate_failed", outcome: "gate_failed", correct: false, fixCycles: 2 }),
      result({
        status: "needs_clarification",
        outcome: "needs_clarification",
        expected: "needs_clarification",
        correct: true,
        reachedDeveloper: false,
        durationMs: 2_000,
        costUsd: 0.1,
      }),
    ]);
    expect(m).toMatchObject({
      total: 4,
      correct: 2,
      verifiedRate: 0.5,
      successClaims: 2,
      falseSuccess: 1,
      falseSuccessRate: 0.5,
      avgFixCycles: 1.67,
      avgDurationSec: 8,
      totalCostUsd: 1.6,
      byOutcome: { verified: 1, false_success: 1, gate_failed: 1, needs_clarification: 1 },
    });
  });

  it("reports a null false success rate when nothing was claimed", () => {
    expect(
      computeMetrics([result({ status: "error", outcome: "error", correct: false })])
        .falseSuccessRate,
    ).toBeNull();
  });
});

describe("parseVitestJson", () => {
  it("extracts counts and failing test names from noisy output", () => {
    const json = {
      numTotalTests: 3,
      numFailedTests: 1,
      testResults: [
        {
          assertionResults: [
            { fullName: "hidden: a works", status: "passed" },
            {
              fullName: "hidden: b rejects",
              status: "failed",
              failureMessages: ["AssertionError: expected 200 to be 409\n  at x"],
            },
          ],
        },
      ],
    };
    const parsed = parseVitestJson(`npm warn something\n${JSON.stringify(json)}\n`);
    expect(parsed).toEqual({
      total: 3,
      failed: 1,
      failures: ["✗ hidden: b rejects: AssertionError: expected 200 to be 409"],
    });
    expect(parseVitestJson("no json here")).toBeNull();
  });
});

const TASK = (id: string): TaskSpec => ({
  id,
  title: id,
  request: "r",
  acceptance_criteria: ["c"],
  scope: { allowed_paths: ["src/**"] },
  budget: { max_fix_cycles: 2, max_cost_usd: 1, timeout_minutes: 15 },
});
const META = (expected: EvalMeta["expected_outcome"]): EvalMeta => ({
  difficulty: "simple",
  expected_outcome: expected,
  traps: [],
});

async function fakeRun(
  task: TaskSpec,
  runsDir: string,
  status: RunStatus,
  worktree: string,
): Promise<RunTaskResult> {
  const dir = path.join(runsDir, `run-${task.id}`);
  await mkdir(dir, { recursive: true });
  const report = {
    status,
    message: `${status} message`,
    fixCycles: status === "success" ? 1 : 0,
    durationMs: 5_000,
    cost: { totalUsd: 0.25, budgetUsd: 1, unknownCostSteps: 0 },
    worktree: { path: worktree, branch: "b", headCommit: "h" },
    steps: status === "needs_clarification" ? [] : [{ kind: "agent", role: "developer" }],
  } as unknown as RunReport;
  return {
    report,
    reportJsonPath: path.join(dir, "report.json"),
    reportMdPath: path.join(dir, "report.md"),
  };
}

describe("runEval", () => {
  it("runs tasks sequentially, verifies successes with hidden tests, survives crashes, writes summaries", async () => {
    const wt = path.join(tmp, "wt");
    await mkdir(path.join(wt, "src"), { recursive: true });
    await writeFile(path.join(wt, "src", "a.ts"), "export {};\n");
    const order: string[] = [];
    const hiddenCalls: string[] = [];

    const { summary, summaryMdPath, summaryJsonPath } = await runEval(
      [
        { task: TASK("ok-task"), meta: META("implemented") },
        { task: TASK("lying-task"), meta: META("implemented") },
        { task: TASK("crash-task"), meta: META("implemented") },
        { task: TASK("contradiction"), meta: META("needs_clarification") },
      ],
      {
        runsDir: tmp,
        runtimeName: "fake",
        models: { planner: "m" },
        runTask: async (task, runsDir) => {
          order.push(task.id);
          if (task.id === "crash-task") throw new Error("boom");
          const status: RunStatus = task.id === "contradiction" ? "needs_clarification" : "success";
          return fakeRun(task, runsDir, status, wt);
        },
        runHidden: (_wt, taskId) => {
          hiddenCalls.push(taskId);
          return Promise.resolve(hidden(taskId === "ok-task"));
        },
      },
    );

    expect(order).toEqual(["ok-task", "lying-task", "crash-task", "contradiction"]);
    expect(hiddenCalls).toEqual(["ok-task", "lying-task"]); // only for success claims
    expect(summary.tasks.map((t) => [t.taskId, t.outcome, t.correct])).toEqual([
      ["ok-task", "verified", true],
      ["lying-task", "false_success", false],
      ["crash-task", "error", false],
      ["contradiction", "needs_clarification", true],
    ]);
    expect(summary.tasks[2]?.message).toContain("boom");
    expect(summary.metrics).toMatchObject({
      total: 4,
      correct: 2,
      verifiedRate: 0.5,
      falseSuccessRate: 0.5,
      hiddenLeaks: 0,
    });
    expect(path.basename(path.dirname(summaryMdPath))).toMatch(/^eval-\d{8}-\d{6}$/);
    const md = await readFile(summaryMdPath, "utf8");
    expect(md).toContain("False success rate");
    expect(md).toContain("**false_success**");
    expect(md).toContain("expected 409");
    expect(JSON.parse(await readFile(summaryJsonPath, "utf8"))).toMatchObject({ schemaVersion: 1 });
  });

  it("detects hidden test files left in an agent worktree", async () => {
    const wt = path.join(tmp, "leaky");
    await mkdir(path.join(wt, "tests", "__hidden__"), { recursive: true });
    await writeFile(path.join(wt, "tests", "__hidden__", "x.test.ts"), "x\n");
    const { summary } = await runEval([{ task: TASK("leaky"), meta: META("implemented") }], {
      runsDir: tmp,
      runtimeName: "fake",
      models: {},
      runTask: (task, runsDir) => fakeRun(task, runsDir, "gate_failed", wt),
      runHidden: () => Promise.reject(new Error("not called")),
    });
    expect(summary.tasks[0]?.hiddenLeaks).toEqual([path.join("tests", "__hidden__", "x.test.ts")]);
    expect(summary.metrics.hiddenLeaks).toBe(1);
  });

  it("stops at the eval cost cap and keeps partial results", async () => {
    const wt = path.join(tmp, "cap-wt");
    await mkdir(wt, { recursive: true });
    const ran: string[] = [];
    const { summary, summaryMdPath } = await runEval(
      ["a", "b", "c", "d"].map((id) => ({ task: TASK(id), meta: META("implemented") })),
      {
        runsDir: tmp,
        runtimeName: "fake",
        models: {},
        costCapUsd: 0.5,
        runTask: (task, runsDir) => {
          ran.push(task.id);
          return fakeRun(task, runsDir, "gate_failed", wt); // each costs $0.25
        },
        runHidden: () => Promise.reject(new Error("not called")),
      },
    );
    expect(ran).toEqual(["a", "b"]);
    expect(summary.costCap).toEqual({ capUsd: 0.5, reached: true, skippedTasks: ["c", "d"] });
    expect(summary.metrics.total).toBe(2);
    expect(await readFile(summaryMdPath, "utf8")).toContain("Stopped at the eval cost cap");
  });
});
