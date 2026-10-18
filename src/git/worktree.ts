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
 * dependency directory (`hostDepsDir`, e.g. node_modules or .venv) is symlinked in so the
 * developer agent can run the project's checks.
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
  /** Dependency directory of the main clone to link in (null: none). */
  hostDepsDir: string | null;
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

  if (opts.hostDepsDir !== null) await linkHostDeps(opts.repoDir, wtPath, opts.hostDepsDir);
  return wt;
}

/** Symlinks `<repoDir>/<depsDir>` into `<wtPath>/<depsDir>` if the source exists. */
export async function linkHostDeps(
  repoDir: string,
  wtPath: string,
  depsDir: string,
): Promise<void> {
  const source = path.join(repoDir, depsDir);
  const link = path.join(wtPath, depsDir);
  if ((await exists(source)) && !(await exists(link))) await symlink(source, link, "dir");
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
export async function snapshot(
  wt: Worktree,
  message: string,
  /** The linked host dependency directory, which must never be committed. */
  hostDepsDir: string | null = null,
): Promise<string> {
  await git(wt.path, ["add", "-A"]);
  const staged = await git(wt.path, ["diff", "--cached", "--name-only"]);
  if (
    hostDepsDir !== null &&
    staged.split("\n").some((f) => f === hostDepsDir || f.startsWith(`${hostDepsDir}/`))
  ) {
    throw new Error(`refusing to snapshot: ${hostDepsDir} is staged`);
  }
  await git(wt.path, ["commit", "-q", "--no-verify", "--allow-empty", "-m", message]);
  return (await git(wt.path, ["rev-parse", "HEAD"])).trim();
}

export interface ChangedFile {
  /** A (added), M (modified), D (deleted), T (type change). Renames are split into D + A. */
  status: string;
  path: string;
}

/** Files changed between `from` (default: the base commit) and HEAD (call after `snapshot`). */
export async function changedFiles(
  wt: Worktree,
  from: string = wt.baseCommit,
): Promise<ChangedFile[]> {
  const out = await git(wt.path, ["diff", "--name-status", "--no-renames", "-z", from, "HEAD"]);
  const parts = out.split("\0").filter((p) => p !== "");
  const files: ChangedFile[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    files.push({ status: parts[i] ?? "", path: parts[i + 1] ?? "" });
  }
  return files;
}

/** Unified diff between `from` (default: the base commit) and HEAD. */
export async function diffFromBase(wt: Worktree, from: string = wt.baseCommit): Promise<string> {
  return git(wt.path, ["diff", "--no-color", "--no-ext-diff", from, "HEAD"]);
}

/** Reads files as they are in `commit` (not the working tree). */
export async function filesAtCommit(
  wt: Worktree,
  commit: string,
  paths: readonly string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const p of paths) out[p] = await git(wt.path, ["show", `${commit}:${p}`]);
  return out;
}

export async function headCommit(wt: Worktree): Promise<string> {
  return (await git(wt.path, ["rev-parse", "HEAD"])).trim();
}
