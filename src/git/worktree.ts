import { access, mkdir, realpath, symlink } from "node:fs/promises";
import path from "node:path";
import { git } from "./git.js";

export interface Worktree {
  path: string;
  branch: string;
  baseCommit: string;
}

/**
 * Creates an isolated worktree of the target repo on a new branch
 * `factory/<taskId>-<runId>`, starting at `baseCommit`. The repo's host-installed
 * node_modules is symlinked in so the developer agent can run the project's checks.
 *
 * Idempotent: if a previous attempt (e.g. a crashed `prepare`) already created the
 * worktree on the expected branch, it is reused and reset to `baseCommit`.
 */
export async function createWorktree(opts: {
  repoDir: string;
  baseCommit: string;
  worktreesDir: string;
  taskId: string;
  runId: string;
}): Promise<Worktree> {
  const name = `${opts.taskId}-${opts.runId}`;
  const branch = `factory/${name}`;
  const wtPath = path.join(opts.worktreesDir, name);
  const wt: Worktree = { path: wtPath, branch, baseCommit: opts.baseCommit };
  await mkdir(opts.worktreesDir, { recursive: true });

  if (await exists(wtPath)) {
    const current = (await git(wtPath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (current !== branch) {
      throw new Error(`${wtPath} exists but is on branch "${current}", expected "${branch}"`);
    }
    await resetWorktree(wt, opts.baseCommit, opts.worktreesDir);
  } else {
    await git(opts.repoDir, ["worktree", "add", "-q", "-b", branch, wtPath, opts.baseCommit]);
  }

  const nodeModules = path.join(opts.repoDir, "node_modules");
  const link = path.join(wtPath, "node_modules");
  if ((await exists(nodeModules)) && !(await exists(link))) {
    await symlink(nodeModules, link, "dir");
  }
  return wt;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Refuses any path that is not a git worktree located directly inside `worktreesRoot`.
 * Guards the destructive commands below: `git reset --hard` / `git clean` must never run
 * on the factory repo, a target's main checkout, or anything else.
 */
export async function assertManagedWorktree(
  wtPath: string,
  worktreesRoot: string,
): Promise<string> {
  const [root, real] = await Promise.all([realpath(worktreesRoot), realpath(wtPath)]);
  if (path.dirname(real) !== root) {
    throw new Error(`refusing to touch ${wtPath}: not a worktree directly under ${worktreesRoot}`);
  }
  const top = await realpath((await git(real, ["rev-parse", "--show-toplevel"])).trim());
  if (top !== real) {
    throw new Error(`refusing to touch ${wtPath}: it is not the top level of a git worktree`);
  }
  return real;
}

/**
 * Restores the worktree to exactly `commit`: discards tracked changes and removes
 * untracked files (ignored files such as the node_modules symlink are kept).
 * Used before re-running a node that changes files, so a replay after a crash never
 * builds on top of partial changes.
 */
export async function resetWorktree(
  wt: Worktree,
  commit: string,
  worktreesRoot: string,
): Promise<void> {
  const dir = await assertManagedWorktree(wt.path, worktreesRoot);
  await git(dir, ["reset", "-q", "--hard", commit]);
  await git(dir, ["clean", "-q", "-fd"]);
}

/**
 * Commits everything in the worktree (including untracked files) as a snapshot and
 * returns the commit hash. Commits even when nothing changed, so every cycle has a
 * snapshot to compare against.
 */
export async function snapshot(wt: Worktree, message: string): Promise<string> {
  await git(wt.path, ["add", "-A"]);
  const staged = await git(wt.path, ["diff", "--cached", "--name-only"]);
  if (staged.split("\n").some((f) => f === "node_modules" || f.startsWith("node_modules/"))) {
    throw new Error("refusing to snapshot: node_modules is staged");
  }
  await git(wt.path, ["commit", "-q", "--no-verify", "--allow-empty", "-m", message]);
  return (await git(wt.path, ["rev-parse", "HEAD"])).trim();
}

export interface ChangedFile {
  /** A (added), M (modified), D (deleted), T (type change). Renames are split into D + A. */
  status: string;
  path: string;
}

/** Files changed between the base commit and HEAD (call after `snapshot`). */
export async function changedFiles(wt: Worktree): Promise<ChangedFile[]> {
  const out = await git(wt.path, [
    "diff",
    "--name-status",
    "--no-renames",
    "-z",
    wt.baseCommit,
    "HEAD",
  ]);
  const parts = out.split("\0").filter((p) => p !== "");
  const files: ChangedFile[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    files.push({ status: parts[i] ?? "", path: parts[i + 1] ?? "" });
  }
  return files;
}

/** Unified diff between the base commit and HEAD. */
export async function diffFromBase(wt: Worktree): Promise<string> {
  return git(wt.path, ["diff", "--no-color", "--no-ext-diff", wt.baseCommit, "HEAD"]);
}

export async function headCommit(wt: Worktree): Promise<string> {
  return (await git(wt.path, ["rev-parse", "HEAD"])).trim();
}
