import { createHash } from "node:crypto";
import { access, appendFile, cp, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { expandHome } from "../config/load-config.js";
import { FACTORY_ROOT } from "../paths.js";
import { runCommand } from "../process/run-command.js";
import type { TargetSource } from "../schemas/config.js";
import { git } from "./git.js";

/** Build and dependency directories never copied from a fixture (any stack). */
const SKIP = new Set([
  ".git",
  ".DS_Store",
  "node_modules",
  "dist",
  "coverage",
  ".venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
]);

/**
 * Immutable tag marking the eval baseline. Factory code never moves it; only an explicit
 * baseline update does (recorded in the DB). Eval runs always start from it.
 */
export const BASELINE_TAG = "factory-baseline";

export type RepoRef = "baseline" | "main";

export interface TargetRepo {
  /** Absolute path of the target's main checkout (its own git repository). */
  dir: string;
  /** Commit this task starts from (the baseline tag for eval runs, main's HEAD otherwise). */
  baseCommit: string;
  /** Commit the baseline tag points to. */
  baselineCommit?: string;
  /** True when this call created the baseline tag (to be recorded in the DB). */
  baselineCreated?: boolean;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Content hash of a fixture directory (paths + bytes), ignoring build/dependency dirs. */
export async function hashDirectory(dir: string): Promise<string> {
  const hash = createHash("sha256");
  async function walk(rel: string): Promise<void> {
    const entries = await readdir(path.join(dir, rel), { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const relPath = path.posix.join(rel, e.name);
      if (e.isDirectory()) await walk(relPath);
      else if (e.isFile()) {
        hash.update(`${relPath}\0`);
        hash.update(await readFile(path.join(dir, relPath)));
        hash.update("\0");
      }
    }
  }
  await walk("");
  return hash.digest("hex").slice(0, 12);
}

/** What the factory needs to materialize a project's repository. */
export interface ProjectSource {
  id: string;
  source: TargetSource;
}

/**
 * Makes sure the project exists as a git repository under `<workdir>/repos/` and returns its
 * base commit. Dependencies are NOT installed here: how to install them is part of the
 * project's config, which is read from this repository afterwards (`ensureHostDeps`).
 *
 * - fixture: files are copied into `repos/<id>-<contentHash>` and committed as
 *   "baseline" on `main`. The directory name is content-addressed, so a changed fixture gets
 *   a fresh repo and an existing one is reused as-is.
 * - git: cloned into `repos/<id>-<urlHash>`, then the branch `ref` is checked out (merges
 *   fast-forward that branch in this clone).
 *
 * `from`: "baseline" = the immutable `factory-baseline` tag (eval); "main" = the HEAD of the
 * clone, i.e. its checked-out target branch (interactive runs).
 */
export async function ensureTargetRepo(
  project: ProjectSource,
  workdir: string,
  from: RepoRef = "main",
): Promise<TargetRepo> {
  const reposDir = path.join(workdir, "repos");
  await mkdir(reposDir, { recursive: true });

  let dir: string;
  if (project.source.kind === "fixture") {
    const src = path.resolve(FACTORY_ROOT, project.source.path);
    dir = path.join(reposDir, `${project.id}-${await hashDirectory(src)}`);
    if (!(await exists(path.join(dir, ".git")))) {
      const staging = `${dir}.tmp-${process.pid}`;
      await rm(staging, { recursive: true, force: true });
      await cp(src, staging, { recursive: true, filter: (p) => !SKIP.has(path.basename(p)) });
      await git(staging, ["init", "-q", "-b", "main"]);
      await git(staging, ["add", "-A"]);
      await git(staging, ["commit", "-q", "--no-verify", "-m", "baseline"]);
      await rename(staging, dir);
    }
  } else {
    const urlHash = createHash("sha256").update(project.source.url).digest("hex").slice(0, 12);
    dir = path.join(reposDir, `${project.id}-${urlHash}`);
    if (!(await exists(path.join(dir, ".git")))) {
      // A local path may be written as ~/...; git itself does not expand it.
      const url = expandHome(project.source.url);
      await git(reposDir, ["clone", "-q", "--no-recurse-submodules", url, dir], 15 * 60_000);
    }
    const current = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (current !== project.source.ref) await git(dir, ["checkout", "-q", project.source.ref]);
  }

  let baselineCreated = false;
  const tagged = await git(dir, ["tag", "--list", BASELINE_TAG]);
  if (tagged.trim() === "") {
    await git(dir, ["tag", BASELINE_TAG, "HEAD"]);
    baselineCreated = true;
  }
  const baselineCommit = (await git(dir, ["rev-parse", `${BASELINE_TAG}^{commit}`])).trim();
  const baseCommit =
    from === "baseline" ? baselineCommit : (await git(dir, ["rev-parse", "HEAD"])).trim();
  return { dir, baseCommit, baselineCommit, baselineCreated };
}

/**
 * Installs the project's dependencies on the host (for the developer's own checks), once:
 * `profile.install` runs in the main clone if `host_deps_dir` is missing. The dependency
 * directory is added to the clone's info/exclude so its per-worktree link never shows up in
 * diffs, whatever the project's own .gitignore says.
 */
export async function ensureHostDeps(
  dir: string,
  profile: { install: readonly string[]; hostDepsDir: string },
): Promise<void> {
  const exclude = path.join(dir, ".git", "info", "exclude");
  const current = (await exists(exclude)) ? await readFile(exclude, "utf8") : "";
  if (!current.split("\n").includes(profile.hostDepsDir)) {
    await mkdir(path.dirname(exclude), { recursive: true });
    await appendFile(exclude, `\n# added by agentic-factory\n${profile.hostDepsDir}\n`);
  }
  if (await exists(path.join(dir, profile.hostDepsDir))) return;
  const [bin, ...args] = profile.install;
  if (bin === undefined) throw new Error("profile.install is empty");
  const res = await runCommand(bin, args, { cwd: dir, timeoutMs: 15 * 60_000 });
  if (res.exitCode !== 0) {
    throw new Error(`${profile.install.join(" ")} failed in ${dir}:\n${res.stderr || res.stdout}`);
  }
}

/**
 * Explicitly moves the baseline tag to the target branch's current head (`npm run baseline:update`).
 * The only code path that changes the tag; merges never do. Returns both commits so the
 * caller can record who moved it, when and from where.
 */
export async function moveBaselineTag(
  repoDir: string,
  targetBranch: string,
): Promise<{ previous: string; current: string }> {
  const previous = (await git(repoDir, ["rev-parse", `${BASELINE_TAG}^{commit}`])).trim();
  const current = (await git(repoDir, ["rev-parse", `${targetBranch}^{commit}`])).trim();
  if (previous !== current) await git(repoDir, ["tag", "-f", BASELINE_TAG, current]);
  return { previous, current };
}

/**
 * Writes the tree of `commit` (tracked files only, no .git) into the existing empty directory
 * `dest`, without touching the repository's index or working tree (`git archive` + `tar`).
 * Returns false if the commit does not exist in the repository.
 */
export async function exportTree(repoDir: string, commit: string, dest: string): Promise<boolean> {
  const known = await runCommand("git", ["cat-file", "-e", `${commit}^{commit}`], {
    cwd: repoDir,
    timeoutMs: 30_000,
  });
  if (known.exitCode !== 0) return false;
  const tar = `${dest}.tar`;
  try {
    await git(repoDir, ["archive", "--format=tar", "-o", tar, commit]);
    const res = await runCommand("tar", ["-xf", tar, "-C", dest], { cwd: dest, timeoutMs: 60_000 });
    if (res.exitCode !== 0) throw new Error(`tar -xf failed: ${res.stderr}`);
    return true;
  } finally {
    await rm(tar, { force: true });
  }
}
