import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunTaskResult } from "../pipeline/run-task.js";
import type { RunReport } from "../schemas/report.js";
import type { TaskSpec } from "../schemas/task.js";
import type { RunStatus } from "../schemas/report.js";
import { resumeMismatch, runEvalRepeated, stat } from "./repeat.js";

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "factory-repeat-test-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const TASK = (id: string): TaskSpec => ({
  id,
  title: id,
  request: "r",
  acceptance_criteria: ["c"],
  scope: { allowed_paths: ["src/**"] },
  budget: { max_fix_cycles: 2, max_cost_usd: 1, timeout_minutes: 15 },
});

describe("stat", () => {
  it("computes mean, sample stdev, min and max; ignores nulls", () => {
    expect(stat([1, 1, 0.5])).toEqual({ n: 3, mean: 0.8333, stdev: 0.2887, min: 0.5, max: 1 });
    expect(stat([0.9])).toEqual({ n: 1, mean: 0.9, stdev: null, min: 0.9, max: 0.9 });
    expect(stat([null, null])).toMatchObject({ n: 0, mean: null });
  });
});

describe("runEvalRepeated", () => {
  it("runs N repeats into r<N>/ and aggregates mean and spread; one cost cap for all repeats", async () => {
    const wt = path.join(tmp, "wt");
    await mkdir(wt, { recursive: true });
    let calls = 0;
    const { summary, summaryMdPath } = await runEvalRepeated(
      [
        {
          task: TASK("a"),
          meta: { difficulty: "simple", expected_outcome: "implemented", traps: [] },
        },
      ],
      {
        repeat: 3,
        roles: { planner: "claude-code:opus", reviewer: "opencode:openai/x" },
        baselineCommit: "abc",
        runsDir: tmp,
        runtimeName: "fake",
        models: {},
        costCapUsd: 0.5,
        runTask: async (task, runsDir): Promise<RunTaskResult> => {
          calls++;
          expect(path.basename(runsDir)).toMatch(/^r\d$/);
          const report = {
            status: calls === 2 ? "review_rejected" : "success",
            message: "",
            fixCycles: calls === 2 ? 2 : 0,
            durationMs: 1000 * calls,
            cost: { totalUsd: 0.3, budgetUsd: 1, unknownCostSteps: 0 },
            worktree: { path: wt, branch: "b", headCommit: "h" },
            steps: [{ kind: "agent", role: "developer" }],
          } as unknown as RunReport;
          await mkdir(path.join(runsDir, `run-${task.id}`), { recursive: true });
          return {
            report,
            reportJsonPath: path.join(runsDir, `run-${task.id}`, "report.json"),
            reportMdPath: path.join(runsDir, `run-${task.id}`, "report.md"),
          };
        },
        runHidden: () =>
          Promise.resolve({
            passed: true,
            exitCode: 0,
            timedOut: false,
            total: 1,
            failed: 0,
            durationMs: 1,
            outputTail: "",
          }),
      },
    );
    // $0.30 per repeat with a $0.50 cap: repeat 2 runs with $0.20 left, repeat 3 is skipped.
    expect(calls).toBe(2);
    expect(summary).toMatchObject({
      repeatsPlanned: 3,
      repeatsDone: 2,
      costCapReached: true,
      baselineCommit: "abc",
    });
    expect(summary.metrics.verifiedRate).toMatchObject({ n: 2, mean: 0.5, min: 0, max: 1 });
    expect(summary.tasks["a"]).toEqual(["verified", "review_rejected✗"]);
    const md = await readFile(summaryMdPath, "utf8");
    expect(md).toContain("2/3 repeat(s)");
    expect(md).toContain("reached, results are partial");
    expect(md).toContain("reviewer = opencode:openai/x");
  });

  it("resume finishes an interrupted pass, then adds repeats up to N, under one cost cap", async () => {
    const wt = path.join(tmp, "wt-resume");
    await mkdir(wt, { recursive: true });
    const tasks = ["a", "b"].map((id) => ({
      task: TASK(id),
      meta: { difficulty: "simple" as const, expected_outcome: "implemented" as const, traps: [] },
    }));
    const calls: string[] = [];
    let limitAt: string | null = "r2/b";
    const deps = {
      roles: { planner: "claude-code:opus", reviewer: "opencode:openai/x" },
      baselineCommit: "abc",
      runsDir: tmp,
      runtimeName: "fake",
      models: {},
      costCapUsd: 5,
      factoryCommit: "f00d",
      runTask: async (task: TaskSpec, runsDir: string): Promise<RunTaskResult> => {
        const key = `${path.basename(runsDir)}/${task.id}`;
        calls.push(key);
        const status: RunStatus = key === limitAt ? "infra_error" : "success";
        await mkdir(path.join(runsDir, `run-${task.id}`), { recursive: true });
        return {
          report: {
            status,
            message: status,
            fixCycles: 0,
            durationMs: 1000,
            cost: { totalUsd: 0.4, budgetUsd: 1, unknownCostSteps: 0 },
            worktree: { path: wt, branch: "b", headCommit: "h" },
            steps: [{ kind: "agent", role: "developer" }],
          } as unknown as RunReport,
          reportJsonPath: path.join(runsDir, `run-${task.id}`, "report.json"),
          reportMdPath: path.join(runsDir, `run-${task.id}`, "report.md"),
        };
      },
      runHidden: () =>
        Promise.resolve({
          passed: true,
          exitCode: 0,
          timedOut: false,
          total: 1,
          failed: 0,
          durationMs: 1,
          outputTail: "",
        }),
      now: () => new Date("2026-10-16T20:00:00Z"),
    };

    const first = await runEvalRepeated(tasks, { ...deps, repeat: 2 });
    expect(calls).toEqual(["r1/a", "r1/b", "r2/a", "r2/b"]);
    expect(first.summary).toMatchObject({ interrupted: true, repeatsDone: 1, repeatsPlanned: 2 });
    expect(first.summary.metrics.verifiedRate).toMatchObject({ n: 1 }); // complete passes only

    calls.length = 0;
    limitAt = null;
    const evalId = first.summary.evalId;
    const resumed = await runEvalRepeated(tasks, { ...deps, repeat: 3, resumeEvalId: evalId });
    // r1 kept, r2 continues at b (a was decided), r3 is new.
    expect(calls).toEqual(["r2/b", "r3/a", "r3/b"]);
    expect(resumed.summary).toMatchObject({
      evalId,
      interrupted: false,
      repeatsDone: 3,
      repeatsPlanned: 3,
    });
    expect(resumed.summary.tasks["b"]).toEqual(["verified", "verified", "verified"]);
    // The replaced attempt (r2/b, $0.40) still counts toward that repeat's cost.
    expect(resumed.summary.metrics.totalCostUsd).toMatchObject({ n: 3, max: 1.2 });
    expect(await readFile(resumed.summaryMdPath, "utf8")).toContain("r3 `f00d`");

    await expect(
      runEvalRepeated(tasks, {
        ...deps,
        repeat: 4,
        resumeEvalId: evalId,
        roles: { ...deps.roles, reviewer: "claude-code:opus" },
      }),
    ).rejects.toThrow(/cannot resume .*roles differ/);
  });
});

describe("resumeMismatch", () => {
  const base = { roles: { a: "x:1", b: "y:2" }, baselineCommit: "c", taskIds: ["t1", "t2"] };
  it("accepts the same measurement regardless of role order", () => {
    expect(resumeMismatch(base, { ...base, roles: { b: "y:2", a: "x:1" } })).toBeNull();
  });
  it("refuses a different baseline commit or task set", () => {
    expect(resumeMismatch(base, { ...base, baselineCommit: "d" })).toMatch(/baseline commit/);
    expect(resumeMismatch(base, { ...base, taskIds: ["t1"] })).toMatch(/task set/);
  });
});
