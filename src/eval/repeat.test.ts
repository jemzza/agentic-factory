import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunTaskResult } from "../pipeline/run-task.js";
import type { RunReport } from "../schemas/report.js";
import type { TaskSpec } from "../schemas/task.js";
import { runEvalRepeated, stat } from "./repeat.js";

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
});
