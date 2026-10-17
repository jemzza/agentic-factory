import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunTaskResult } from "../pipeline/run-task.js";
import type { RunReport, RunStatus } from "../schemas/report.js";
import type { EvalMeta, TaskSpec } from "../schemas/task.js";
import type { HiddenTestResult } from "./hidden-tests.js";
import { parseVitestJson } from "./hidden-tests.js";
import { classify, computeMetrics, firstPassOf, runEval, type EvalTaskResult } from "./run-eval.js";

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
    gateFixCycles: 0,
    reviewCycles: 0,
    maxReviewCycles: 1,
    specRevisions: 0,
    firstPass: null,
    reachedDeveloper: true,
    reachedReview: true,
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

  it("leaves infra_error out of every metric and counts it separately", () => {
    const m = computeMetrics([
      result({}),
      result({
        status: "infra_error",
        outcome: "infra_error",
        correct: false,
        durationMs: 1_000,
        costUsd: 0.3,
      }),
    ]);
    expect(m).toMatchObject({
      total: 1,
      correct: 1,
      verifiedRate: 1,
      totalCostUsd: 0.5,
      avgDurationSec: 10,
      excludedInfra: 1,
      byOutcome: { verified: 1 },
    });
  });

  it("first-pass rate: verified with no rework, over implementable tasks; split cycle means", () => {
    const rejected = {
      status: "review_rejected",
      outcome: "review_rejected",
      correct: false,
    } as const;
    const m = computeMetrics([
      result({ taskId: "clean" }),
      result({ taskId: "after-review", fixCycles: 1, reviewCycles: 1 }),
      result({ taskId: "after-gate", fixCycles: 1, gateFixCycles: 1 }),
      result({ taskId: "rejected", ...rejected, fixCycles: 1, reviewCycles: 1 }),
      result({
        taskId: "gate-failed",
        status: "gate_failed",
        outcome: "gate_failed",
        correct: false,
        fixCycles: 2,
        gateFixCycles: 2,
        reachedReview: false,
      }),
      // Recorded before the split (NULL counters): still decidable from fixCycles, but left
      // out of the split-cycle means.
      result({ taskId: "legacy-clean", gateFixCycles: null, reviewCycles: null }),
      result({ taskId: "legacy-fixed", fixCycles: 1, gateFixCycles: null, reviewCycles: null }),
      // Contradictory task: right answer and wrong answer; neither is in the denominator.
      result({
        taskId: "contradiction-ok",
        expected: "needs_clarification",
        status: "needs_clarification",
        outcome: "needs_clarification",
        reachedDeveloper: false,
        reachedReview: false,
      }),
      result({
        taskId: "contradiction-implemented",
        expected: "needs_clarification",
        correct: false,
      }),
      // Provider limit: out of every metric.
      result({
        taskId: "limited",
        status: "infra_error",
        outcome: "infra_error",
        correct: false,
        reachedReview: false,
      }),
    ]);
    expect(m).toMatchObject({
      firstPass: 2, // clean, legacy-clean
      firstPassDenominator: 7,
      firstPassRate: 0.2857,
      clarificationTasks: 2,
      clarificationCorrect: 1,
      // Tasks that reached the developer with known counters (incl. the implemented
      // contradiction): gate (0+0+1+0+2+0)/6, review (0+1+0+1+0+0)/6.
      avgGateFixCycles: 0.5,
      avgReviewCycles: 0.33,
      splitCyclesKnown: 6,
      gateFailed: 1,
      reviewRejected: 1,
      reviewed: 7,
      reviewLimitStopRate: 0.1429,
      reviewBudgetExhausted: 2, // after-review, rejected
      excludedInfra: 1,
    });
  });

  it("firstPassOf ignores spec revisions and is undefined for clarification and infra", () => {
    const base = { expected: "implemented", outcome: "verified", fixCycles: 0 } as const;
    expect(firstPassOf({ ...base, gateFixCycles: 0, reviewCycles: 0 })).toBe(true);
    expect(firstPassOf({ ...base, gateFixCycles: 0, reviewCycles: 1, fixCycles: 1 })).toBe(false);
    expect(
      firstPassOf({ ...base, outcome: "false_success", gateFixCycles: 0, reviewCycles: 0 }),
    ).toBe(false);
    expect(firstPassOf({ ...base, gateFixCycles: null, reviewCycles: null })).toBe(true);
    expect(
      firstPassOf({ ...base, expected: "needs_clarification", gateFixCycles: 0, reviewCycles: 0 }),
    ).toBeNull();
    expect(
      firstPassOf({ ...base, outcome: "infra_error", gateFixCycles: 0, reviewCycles: 0 }),
    ).toBeNull();
    // A spec rejected by a human twice, then implemented cleanly, is still first pass.
    const spec = result({ specRevisions: 2 });
    expect(firstPassOf(spec)).toBe(true);
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
  budget: { max_gate_fix_cycles: 2, max_review_cycles: 1, max_cost_usd: 1, timeout_minutes: 15 },
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
  extra: Partial<RunReport> = {},
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
    ...extra,
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

  it("records the first-pass decision per finished run and carries split counters", async () => {
    const wt = path.join(tmp, "fp-wt");
    await mkdir(wt, { recursive: true });
    const recorded: [string, boolean | null][] = [];
    const steps = [
      { kind: "agent", role: "developer" },
      { kind: "agent", role: "reviewer" },
    ] as unknown as RunReport["steps"];
    const { summary } = await runEval(
      [
        { task: TASK("clean"), meta: META("implemented") },
        { task: TASK("reworked"), meta: META("implemented") },
        { task: TASK("contradiction"), meta: META("needs_clarification") },
      ],
      {
        runsDir: tmp,
        runtimeName: "fake",
        models: {},
        runTask: (task, runsDir) =>
          task.id === "contradiction"
            ? fakeRun(task, runsDir, "needs_clarification", wt)
            : fakeRun(task, runsDir, "success", wt, {
                steps,
                fixCycles: task.id === "clean" ? 0 : 1,
                gateFixCycles: 0,
                reviewCycles: task.id === "clean" ? 0 : 1,
                specRevisions: 1,
              }),
        runHidden: () => Promise.resolve(hidden(true)),
        recordFirstPass: (run, firstPass) => {
          recorded.push([path.basename(path.dirname(run.reportJsonPath)), firstPass]);
          return Promise.resolve();
        },
      },
    );
    expect(recorded).toEqual([
      ["run-clean", true],
      ["run-reworked", false],
      ["run-contradiction", null],
    ]);
    expect(
      summary.tasks.map((t) => [t.taskId, t.firstPass, t.reviewCycles, t.reachedReview]),
    ).toEqual([
      ["clean", true, 0, true],
      ["reworked", false, 1, true],
      ["contradiction", null, null, false],
    ]);
    expect(summary.metrics).toMatchObject({
      firstPass: 1,
      firstPassDenominator: 2,
      firstPassRate: 0.5,
    });
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

  it("stops the pass at a provider limit; resume keeps decided tasks and runs the rest", async () => {
    const wt = path.join(tmp, "infra-wt");
    await mkdir(wt, { recursive: true });
    const evalDir = path.join(tmp, "eval-infra", "r1");
    const tasks = ["a", "b", "c", "d"].map((id) => ({ task: TASK(id), meta: META("implemented") }));
    const ran: string[] = [];
    const deps = {
      runsDir: tmp,
      evalId: "eval-infra/r1",
      evalDir,
      runtimeName: "fake",
      models: {},
      factoryCommit: "abc123",
      runHidden: () => Promise.resolve(hidden(true)),
    };
    let limited = true;
    const first = await runEval(tasks, {
      ...deps,
      runTask: (task, runsDir) => {
        ran.push(task.id);
        const status: RunStatus = task.id === "b" && limited ? "infra_error" : "gate_failed";
        return fakeRun(task, runsDir, status, wt);
      },
    });
    // b hit the limit: c and d are not started (they would fail the same way).
    expect(ran).toEqual(["a", "b"]);
    expect(first.summary.interrupted).toEqual({
      reason: "infra_error message",
      pendingTasks: ["b", "c", "d"],
    });
    expect(first.summary.metrics).toMatchObject({ total: 1, excludedInfra: 1, totalCostUsd: 0.25 });
    expect(await readFile(first.summaryMdPath, "utf8")).toContain(
      "Interrupted: the model provider was unavailable",
    );

    limited = false;
    ran.length = 0;
    const resumed = await runEval(tasks, {
      ...deps,
      previous: first.summary,
      runTask: (task, runsDir) => {
        ran.push(task.id);
        return fakeRun(task, runsDir, "success", wt);
      },
    });
    expect(ran).toEqual(["b", "c", "d"]); // a is kept as decided before
    expect(resumed.summary.interrupted).toBeNull();
    expect(resumed.summary.tasks.map((t) => [t.taskId, t.outcome])).toEqual([
      ["a", "gate_failed"],
      ["b", "verified"],
      ["c", "verified"],
      ["d", "verified"],
    ]);
    expect(resumed.summary).toMatchObject({
      startedAt: first.summary.startedAt,
      factoryCommit: "abc123",
      replacedCostUsd: 0.25, // the attempt of b that hit the limit
      replacedInfraTasks: ["b"], // the infra_error stays visible after the resume replaced it
    });
    expect(resumed.summary.metrics).toMatchObject({ total: 4, excludedInfra: 0 });
    expect(await readFile(path.join(evalDir, "summary.md"), "utf8")).toContain(
      "| Excluded: provider unavailable (infra_error) | 0 task(s) still pending; 1 attempt(s) replaced by a resume (`b`)",
    );
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
