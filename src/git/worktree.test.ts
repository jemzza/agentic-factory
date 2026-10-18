import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FACTORY_ROOT } from "../paths.js";
import { makeFakeRepo } from "../testing/fakes.js";
import { git } from "./git.js";
import { assertManagedWorktree, createWorktree, resetWorktree, snapshot } from "./worktree.js";

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "factory-worktree-test-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function setup(name: string) {
  const repo = await makeFakeRepo(path.join(tmp, name, "repo"));
  const worktreesDir = path.join(tmp, name, "worktrees");
  const wt = await createWorktree({
    repoDir: repo.dir,
    baseCommit: repo.baseCommit,
    worktreesDir,
    taskId: "t",
    runId: "r1",
    hostDepsDir: "node_modules",
  });
  return { repo, worktreesDir, wt };
}

describe("resetWorktree", () => {
  it("restores the snapshot: tracked edits reverted, untracked files removed", async () => {
    const { wt, worktreesDir } = await setup("reset");
    await writeFile(path.join(wt.path, "src", "a.ts"), "export const a = 1;\n");
    const snap = await snapshot(wt, "snap");
    await writeFile(path.join(wt.path, "src", "a.ts"), "export const a = 2;\n");
    await writeFile(path.join(wt.path, "src", "partial.ts"), "half-written");
    await mkdir(path.join(wt.path, "newdir"));
    await writeFile(path.join(wt.path, "newdir", "x.ts"), "x");

    await resetWorktree(wt, snap, worktreesDir);

    expect(await readFile(path.join(wt.path, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect((await git(wt.path, ["status", "--porcelain"])).trim()).toBe("");
  });

  it("refuses the target's main checkout, the factory repo and paths outside the worktrees root", async () => {
    const { repo, worktreesDir, wt } = await setup("guard");
    await expect(assertManagedWorktree(repo.dir, worktreesDir)).rejects.toThrow(/refusing/);
    await expect(assertManagedWorktree(FACTORY_ROOT, worktreesDir)).rejects.toThrow(/refusing/);
    await expect(assertManagedWorktree(path.join(wt.path, "src"), worktreesDir)).rejects.toThrow(
      /refusing/,
    );
    const plainDir = path.join(worktreesDir, "not-a-worktree");
    await mkdir(plainDir);
    // A directory under the root that is not its own worktree resolves to an enclosing repo → refused.
    await expect(assertManagedWorktree(plainDir, worktreesDir)).rejects.toThrow();
    await expect(
      resetWorktree(
        { path: repo.dir, branch: "main", baseCommit: repo.baseCommit },
        repo.baseCommit,
        worktreesDir,
      ),
    ).rejects.toThrow(/refusing/);
    expect(await assertManagedWorktree(wt.path, worktreesDir)).toBeTruthy();
  });
});

describe("createWorktree", () => {
  it("is idempotent: a second call reuses the worktree and resets it to the base commit", async () => {
    const { repo, worktreesDir, wt } = await setup("idempotent");
    await writeFile(path.join(wt.path, "leftover.ts"), "from a crashed prepare");
    const again = await createWorktree({
      repoDir: repo.dir,
      baseCommit: repo.baseCommit,
      worktreesDir,
      taskId: "t",
      runId: "r1",
      hostDepsDir: "node_modules",
    });
    expect(again).toEqual(wt);
    expect((await git(wt.path, ["status", "--porcelain"])).trim()).toBe("");
  });
});
