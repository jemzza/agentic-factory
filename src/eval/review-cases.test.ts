import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareTargetCopy } from "./target-copy.js";
import { FIXTURES_DIR } from "../paths.js";
import { runCommand } from "../process/run-command.js";
import { loadReviewCases, verifyManifest } from "./review-cases.js";
import { listTaskIds } from "./tasks.js";

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "factory-review-cases-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("evals/review case set", () => {
  it("matches its manifest (the set is frozen once reviewers have run on it)", async () => {
    expect(await verifyManifest()).toEqual([]);
  });

  it("has 5 clean and 10 defect cases, each tied to an existing task", async () => {
    const cases = await loadReviewCases();
    const tasks = new Set(await listTaskIds());
    expect(cases.filter((c) => c.kind === "clean")).toHaveLength(5);
    expect(cases.filter((c) => c.kind === "defect")).toHaveLength(10);
    for (const c of cases) {
      expect(tasks.has(c.task), c.id).toBe(true);
      expect(c.gate_passes, c.id).toBe(true);
    }
  });

  it("every diff applies cleanly to the TaskFlow baseline", async () => {
    for (const c of await loadReviewCases()) {
      const dir = path.join(tmp, c.id);
      await prepareTargetCopy({ source: path.join(FIXTURES_DIR, "taskflow"), dest: dir });
      const res = await runCommand("git", ["apply", "--check", c.patchPath], {
        cwd: dir,
        timeoutMs: 30_000,
      });
      expect(res.exitCode, `${c.id}: ${res.stderr}`).toBe(0);
    }
  }, 60_000);
});
