import { createHash } from "node:crypto";
import { access, appendFile, cp, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { FACTORY_ROOT } from "../paths.js";
import { runCommand } from "../process/run-command.js";
import type { TargetConfig } from "../schemas/config.js";
import { git } from "./git.js";

const SKIP = new Set(["node_modules", ".git", "dist", "coverage"]);

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

/**
 * Makes sure the target exists as a git repository under `<workdir>/repos/` with
 * dependencies installed on the host, and returns its base commit.
 *
 * - fixture: files are copied into `repos/<name>-<contentHash>` and committed as
 *   "baseline". The directory name is content-addressed, so a changed fixture gets a
 *   fresh repo and an existing one is reused as-is.
 * - git: cloned into `repos/<name>-<urlHash>`, then `ref` is checked out (detached).
 *
 * `node_modules` is added to the repo's info/exclude so the per-worktree symlink never
 * shows up in diffs, whatever the target's own .gitignore says.
 */
export async function ensureTargetRepo(
  target: TargetConfig,
  workdir: string,
  from: RepoRef = "main",
): Promise<TargetRepo> {
  const reposDir = path.join(workdir, "repos");
  await mkdir(reposDir, { recursive: true });

  let dir: string;
  if (target.source.kind === "fixture") {
    const src = path.resolve(FACTORY_ROOT, target.source.path);
    dir = path.join(reposDir, `${target.name}-${await hashDirectory(src)}`);
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
    const urlHash = createHash("sha256").update(target.source.url).digest("hex").slice(0, 12);
    dir = path.join(reposDir, `${target.name}-${urlHash}`);
    if (!(await exists(path.join(dir, ".git")))) {
      await git(
        reposDir,
        ["clone", "-q", "--no-recurse-submodules", target.source.url, dir],
        15 * 60_000,
      );
    }
    await git(dir, ["checkout", "-q", "--detach", target.source.ref]);
  }

  const exclude = path.join(dir, ".git", "info", "exclude");
  const current = (await exists(exclude)) ? await readFile(exclude, "utf8") : "";
  if (!current.split("\n").includes("node_modules")) {
    await mkdir(path.dirname(exclude), { recursive: true });
    await appendFile(exclude, "\n# added by agentic-factory\nnode_modules\n");
  }

  if (!(await exists(path.join(dir, "node_modules")))) {
    const [bin, ...args] = target.install;
    if (bin === undefined) throw new Error("target.install is empty");
    const res = await runCommand(bin, args, { cwd: dir, timeoutMs: 15 * 60_000 });
    if (res.exitCode !== 0) {
      throw new Error(`${target.install.join(" ")} failed in ${dir}:\n${res.stderr || res.stdout}`);
    }
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
 * Explicitly moves the baseline tag to main's current head (`npm run baseline:update`).
 * The only code path that changes the tag; merges never do. Returns both commits so the
 * caller can record who moved it, when and from where.
 */
export async function moveBaselineTag(
  repoDir: string,
): Promise<{ previous: string; current: string }> {
  const previous = (await git(repoDir, ["rev-parse", `${BASELINE_TAG}^{commit}`])).trim();
  const current = (await git(repoDir, ["rev-parse", "main^{commit}"])).trim();
  if (previous !== current) await git(repoDir, ["tag", "-f", BASELINE_TAG, current]);
  return { previous, current };
}
