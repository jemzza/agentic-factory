import { access, rm } from "node:fs/promises";
import path from "node:path";
import { git, GitError } from "./git.js";
import { assertManagedWorktree, linkHostDeps } from "./worktree.js";

// "main" below means the project's target branch (`target_branch` in .factory/config.yaml):
// the integration branch humans merge into. Every function takes it explicitly.

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function revParse(dir: string, ref: string): Promise<string> {
  return (await git(dir, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
}

/** True when `commit` is already reachable from main (the run's branch was merged). */
export async function isMergedIntoMain(
  repoDir: string,
  commit: string,
  targetBranch: string,
): Promise<boolean> {
  try {
    await git(repoDir, ["merge-base", "--is-ancestor", commit, targetBranch]);
    return true;
  } catch (err) {
    if (err instanceof GitError) return false;
    throw err;
  }
}

/** The merge commit on main that brought in `runId`, if any (searched by its trailer). */
export async function findMergeCommit(
  repoDir: string,
  runId: string,
  targetBranch: string,
): Promise<string | null> {
  const out = await git(repoDir, [
    "log",
    targetBranch,
    "--merges",
    "--format=%H",
    "--fixed-strings",
    `--grep=Factory-Run: ${runId}`,
  ]);
  return (
    out
      .split("\n")
      .find((l) => l.trim() !== "")
      ?.trim() ?? null
  );
}

export async function removeTempWorktree(repoDir: string, wtPath: string): Promise<void> {
  if (await exists(wtPath)) {
    await git(repoDir, ["worktree", "remove", "--force", wtPath]).catch(() => undefined);
    await rm(wtPath, { recursive: true, force: true });
  }
  await git(repoDir, ["worktree", "prune"]);
}

export type MergeCandidate =
  | {
      kind: "ready";
      /** Merge commit (not yet on main): branch merged into main's current head, spec archived. */
      mergeCommit: string;
      /** Main's head the candidate was built on; main may only move if it still points here. */
      mainBefore: string;
      /** Temporary worktree holding the candidate (for the gate); remove when done. */
      worktreePath: string;
      archivedAs: string | null;
    }
  | { kind: "conflict"; mainBefore: string; files: string[] };

/**
 * Builds the merge result before touching main: a temporary worktree at main's current head,
 * `git merge --no-ff --no-commit <branch>`, then `archive` (OpenSpec) inside the same
 * worktree, and ONE merge commit containing both. Conflicts with changes that reached main
 * after the run started are reported, never auto-resolved.
 */
export async function prepareMergeCandidate(opts: {
  repoDir: string;
  branch: string;
  worktreesRoot: string;
  runId: string;
  message: string;
  archive: (worktreePath: string) => Promise<string | null>;
  targetBranch: string;
  /** Dependency directory of the main clone to link in for the gate (null: none). */
  hostDepsDir: string | null;
}): Promise<MergeCandidate> {
  const mainBefore = await revParse(opts.repoDir, opts.targetBranch);
  const wtPath = path.join(opts.worktreesRoot, `merge-${opts.runId}`);
  await removeTempWorktree(opts.repoDir, wtPath);
  await git(opts.repoDir, ["worktree", "add", "-q", "--detach", wtPath, mainBefore]);
  await assertManagedWorktree(wtPath, opts.worktreesRoot);
  if (opts.hostDepsDir !== null) await linkHostDeps(opts.repoDir, wtPath, opts.hostDepsDir);

  try {
    await git(wtPath, ["merge", "--no-ff", "--no-commit", opts.branch]);
  } catch (err) {
    if (!(err instanceof GitError)) throw err;
    const conflicted = (await git(wtPath, ["diff", "--name-only", "--diff-filter=U"]))
      .split("\n")
      .filter((f) => f.trim() !== "");
    await git(wtPath, ["merge", "--abort"]).catch(() => undefined);
    await removeTempWorktree(opts.repoDir, wtPath);
    return { kind: "conflict", mainBefore, files: conflicted };
  }

  const archivedAs = await opts.archive(wtPath);
  await git(wtPath, ["add", "-A"]);
  await git(wtPath, ["commit", "-q", "--no-verify", "-m", opts.message]);
  const mergeCommit = await revParse(wtPath, "HEAD");
  return { kind: "ready", mergeCommit, mainBefore, worktreePath: wtPath, archivedAs };
}

/**
 * Moves main to `mergeCommit` (fast-forward only) in the target's main checkout, but only if
 * main still points at `mainBefore` — i.e. nothing landed while the candidate was checked.
 */
export async function fastForwardMain(
  repoDir: string,
  mainBefore: string,
  mergeCommit: string,
  targetBranch: string,
): Promise<{ kind: "moved" } | { kind: "main_moved"; mainNow: string }> {
  const mainNow = await revParse(repoDir, targetBranch);
  if (mainNow !== mainBefore) return { kind: "main_moved", mainNow };
  const current = (await git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (current !== targetBranch) {
    throw new Error(
      `${repoDir} must have ${targetBranch} checked out to receive merges (found ${current})`,
    );
  }
  await git(repoDir, ["merge", "-q", "--ff-only", mergeCommit]);
  return { kind: "moved" };
}
