import { access, mkdir, symlink } from "node:fs/promises";
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
  await mkdir(opts.worktreesDir, { recursive: true });
  await git(opts.repoDir, ["worktree", "add", "-q", "-b", branch, wtPath, opts.baseCommit]);

  const nodeModules = path.join(opts.repoDir, "node_modules");
  try {
    await access(nodeModules);
    await symlink(nodeModules, path.join(wtPath, "node_modules"), "dir");
  } catch {
    // Target without host dependencies: nothing to link.
  }
  return { path: wtPath, branch, baseCommit: opts.baseCommit };
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
