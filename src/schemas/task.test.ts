import { describe, expect, it } from "vitest";
import { RunReportSchema } from "./report.js";
import { cycleLimits, StoredTaskSpecSchema, TaskSpecSchema } from "./task.js";

const TASK = {
  id: "t",
  title: "T",
  request: "r",
  acceptance_criteria: ["c"],
  scope: { allowed_paths: ["src/**"] },
};
const LEGACY_BUDGET = { max_fix_cycles: 2, max_cost_usd: 1, timeout_minutes: 15 };

describe("stored task budget", () => {
  it("reads tasks recorded before the split without reinterpreting the shared limit", () => {
    const stored = StoredTaskSpecSchema.parse({ ...TASK, budget: LEGACY_BUDGET });
    expect(stored.budget).toEqual(LEGACY_BUDGET);
    expect(cycleLimits(stored.budget)).toBeNull();
  });

  it("gives the separate limits of a current task", () => {
    const task = TaskSpecSchema.parse({
      ...TASK,
      budget: {
        max_gate_fix_cycles: 1,
        max_review_cycles: 0,
        max_cost_usd: 1,
        timeout_minutes: 15,
      },
    });
    expect(cycleLimits(task.budget)).toEqual({ gateFix: 1, review: 0 });
  });

  it("caps each kind of cycle at 2", () => {
    const over = { max_gate_fix_cycles: 3, max_cost_usd: 1, timeout_minutes: 15 };
    expect(TaskSpecSchema.safeParse({ ...TASK, budget: over }).success).toBe(false);
  });

  it("keeps a pre-split report.json readable", () => {
    const report = {
      schemaVersion: 1,
      runId: "r",
      status: "success",
      message: "gate passed and reviewer approved after 0 fix cycle(s)",
      startedAt: "2026-10-15T00:00:00Z",
      finishedAt: "2026-10-15T00:01:00Z",
      durationMs: 60000,
      task: { ...TASK, budget: LEGACY_BUDGET },
      runtime: "claude-code",
      models: {},
      target: null,
      worktree: null,
      plan: null,
      fixCycles: 0,
      steps: [],
      review: null,
      gate: null,
      cost: { totalUsd: 0, budgetUsd: 1, unknownCostSteps: 0 },
      changedFiles: [],
      diff: "",
    };
    expect(RunReportSchema.parse(report).task.budget).toEqual(LEGACY_BUDGET);
  });
});
