import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureTargetRepo } from "./target-repo.js";

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "factory-target-repo-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("ensureTargetRepo", () => {
  it("never clones a GitHub project without the factory's remote (no fallback to the owner's credentials)", async () => {
    await expect(
      ensureTargetRepo(
        {
          id: "gh-project",
          source: { kind: "git", url: "https://github.com/owner/repo.git", ref: "main" },
        },
        tmp,
        "main",
      ),
    ).rejects.toThrow(/cloned only with the factory's token/);
  });
});
