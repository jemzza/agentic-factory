import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TASKS_DIR } from "../paths.js";
import {
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
});
