import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TASKS_DIR } from "../paths.js";
import { DEFAULT_MAX_GATE_FIX_CYCLES, DEFAULT_MAX_REVIEW_CYCLES } from "../schemas/task.js";
import {
  DEFAULT_EVAL_DIRS,
  listHiddenTestFiles,
  listTaskIds,
  loadEvalMeta,
  loadTaskSpec,
  referencePatchPath,
} from "./tasks.js";

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

describe("eval task set", () => {
  it("has 10 tasks, all valid against the schemas", async () => {
    const ids = await listTaskIds();
    expect(ids).toHaveLength(10);
    for (const id of ids) {
      const spec = await loadTaskSpec(id);
      expect(spec.id).toBe(id);
      await loadEvalMeta(id);
    }
  });

  it("has the required difficulty mix: 4 simple, 4 medium, 2 hard", async () => {
    const counts: Record<string, number> = {};
    for (const id of await listTaskIds()) {
      const { difficulty } = await loadEvalMeta(id);
      counts[difficulty] = (counts[difficulty] ?? 0) + 1;
    }
    expect(counts).toEqual({ simple: 4, medium: 4, hard: 2 });
  });

  it("has at least 2 trap tasks and at least 1 contradiction task", async () => {
    let traps = 0;
    let clarifications = 0;
    for (const id of await listTaskIds()) {
      const meta = await loadEvalMeta(id);
      if (meta.expected_outcome === "implemented" && meta.traps.length > 0) traps++;
      if (meta.expected_outcome === "needs_clarification") clarifications++;
    }
    expect(traps).toBeGreaterThanOrEqual(2);
    expect(clarifications).toBeGreaterThanOrEqual(1);
  });

  it("has hidden tests for every task and a reference patch exactly for implementable ones", async () => {
    for (const id of await listTaskIds()) {
      expect(await listHiddenTestFiles(id), id).not.toHaveLength(0);
      const meta = await loadEvalMeta(id);
      expect(await exists(referencePatchPath(id)), id).toBe(
        meta.expected_outcome === "implemented",
      );
    }
  });

  it("keeps eval-only hints out of the visible task definitions", async () => {
    for (const id of await listTaskIds()) {
      const visible = await readFile(path.join(TASKS_DIR, id, "task.yaml"), "utf8");
      expect(visible, id).not.toMatch(/difficulty|expected_outcome|trap|clarif/i);
    }
  });

  it("rejects ids that could escape the tasks directory", async () => {
    await expect(loadTaskSpec("../hidden/x")).rejects.toThrow(/Invalid task id/);
  });

  it("states both cycle budgets explicitly in every task file", async () => {
    for (const id of await listTaskIds()) {
      const raw = await readFile(path.join(TASKS_DIR, id, "task.yaml"), "utf8");
      expect(raw, id).toMatch(/^ {2}max_gate_fix_cycles: \d+$/m);
      expect(raw, id).toMatch(/^ {2}max_review_cycles: \d+$/m);
      expect(raw, id).not.toMatch(/max_fix_cycles/);
    }
  });
});

describe("task budget", () => {
  const writeTask = async (budget: string) => {
    const tasksDir = await mkdtemp(path.join(os.tmpdir(), "factory-task-"));
    await mkdir(path.join(tasksDir, "t"));
    await writeFile(
      path.join(tasksDir, "t", "task.yaml"),
      [
        "id: t",
        "title: T",
        "request: r",
        "acceptance_criteria: [c]",
        "scope:",
        '  allowed_paths: ["src/**"]',
        "budget:",
        budget,
      ].join("\n"),
    );
    return { ...DEFAULT_EVAL_DIRS, tasksDir };
  };

  it("rejects the legacy shared max_fix_cycles with an error naming the new fields", async () => {
    const dirs = await writeTask("  max_fix_cycles: 2\n  max_cost_usd: 1\n  timeout_minutes: 15");
    try {
      await expect(loadTaskSpec("t", dirs)).rejects.toThrow(
        /budget\.max_fix_cycles: .*max_gate_fix_cycles.*max_review_cycles/,
      );
    } finally {
      await rm(dirs.tasksDir, { recursive: true, force: true });
    }
  });

  it("defaults omitted cycle budgets from the single definition", async () => {
    const dirs = await writeTask("  max_cost_usd: 1\n  timeout_minutes: 15");
    try {
      const spec = await loadTaskSpec("t", dirs);
      expect(spec.budget).toMatchObject({
        max_gate_fix_cycles: DEFAULT_MAX_GATE_FIX_CYCLES,
        max_review_cycles: DEFAULT_MAX_REVIEW_CYCLES,
      });
      expect([DEFAULT_MAX_GATE_FIX_CYCLES, DEFAULT_MAX_REVIEW_CYCLES]).toEqual([2, 1]);
    } finally {
      await rm(dirs.tasksDir, { recursive: true, force: true });
    }
  });
});
