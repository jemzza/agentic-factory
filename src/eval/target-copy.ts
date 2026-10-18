import { access, copyFile, cp, mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { HIDDEN_HARNESS_FILE } from "../paths.js";
import { runCommand, succeeded } from "../process/run-command.js";

/** Build and dependency directories of any stack: never copied (the sandbox has its own). */
const SKIP_DIRS = new Set([
  ".git",
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
 * Copies a target repository's working files into `dest` (no .git, build or dependency
 * directories) and makes `dest` its own git repo so that `git apply` / `git diff` never
 * resolve against an enclosing repository. Dependencies come from the sandbox image; pass
 * `hostDeps` only to run checks on the host.
 */
export async function prepareTargetCopy(opts: {
  source: string;
  dest: string;
  hostDeps?: { from: string; dir: string };
}): Promise<void> {
  await cp(opts.source, opts.dest, {
    recursive: true,
    filter: (src) => !SKIP_DIRS.has(path.basename(src)),
  });
  if (opts.hostDeps !== undefined) {
    const deps = path.join(opts.hostDeps.from, opts.hostDeps.dir);
    try {
      await access(deps);
    } catch {
      throw new Error(`${deps} is missing; install the project's dependencies first`);
    }
    await symlink(deps, path.join(opts.dest, opts.hostDeps.dir), "dir");
  }
  const init = await runCommand("git", ["init", "-q"], { cwd: opts.dest, timeoutMs: 30_000 });
  if (!succeeded(init)) throw new Error(`git init failed in ${opts.dest}: ${init.stderr}`);
}

/** Applies a patch produced by `git diff` to a prepared copy. */
export async function applyPatch(dest: string, patchFile: string): Promise<void> {
  const res = await runCommand("git", ["apply", "--whitespace=nowarn", patchFile], {
    cwd: dest,
    timeoutMs: 30_000,
  });
  if (!succeeded(res)) throw new Error(`git apply ${patchFile} failed: ${res.stderr}`);
}

/**
 * Copies hidden tests (and their harness) into `<dest>/<dirInTarget>/` (the eval stand's
 * `hidden_tests.dir`) and returns that relative directory.
 * Only ever call this on a throwaway copy — never on an agent worktree.
 */
export async function installHiddenTests(
  dest: string,
  hiddenTestFiles: readonly string[],
  dirInTarget: string,
): Promise<string> {
  if (hiddenTestFiles.length === 0) throw new Error("No hidden test files to install");
  const dir = path.join(dest, dirInTarget);
  await mkdir(dir, { recursive: true });
  await copyFile(HIDDEN_HARNESS_FILE, path.join(dir, path.basename(HIDDEN_HARNESS_FILE)));
  for (const file of hiddenTestFiles) {
    await copyFile(file, path.join(dir, path.basename(file)));
  }
  return dirInTarget;
}
