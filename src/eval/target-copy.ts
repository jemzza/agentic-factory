import { access, copyFile, cp, mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { HIDDEN_HARNESS_FILE, HIDDEN_TESTS_DIR_IN_TARGET } from "../paths.js";
import { runCommand, succeeded } from "../process/run-command.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage"]);

/**
 * Copies a target repository's working files into `dest` (no node_modules/.git/dist),
 * links `node_modules` from `nodeModulesFrom`, and makes `dest` its own git repo so
 * that `git apply` / `git diff` never resolve against an enclosing repository.
 */
export async function prepareTargetCopy(opts: {
  source: string;
  dest: string;
  nodeModulesFrom: string;
}): Promise<void> {
  const nodeModules = path.join(opts.nodeModulesFrom, "node_modules");
  try {
    await access(nodeModules);
  } catch {
    throw new Error(`${nodeModules} is missing; run \`npm ci\` in ${opts.nodeModulesFrom}`);
  }
  await cp(opts.source, opts.dest, {
    recursive: true,
    filter: (src) => !SKIP_DIRS.has(path.basename(src)),
  });
  await symlink(nodeModules, path.join(opts.dest, "node_modules"), "dir");
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
 * Copies hidden tests (and their harness) into `<dest>/tests/__hidden__/`.
 * Only ever call this on a throwaway copy — never on an agent worktree.
 */
export async function installHiddenTests(
  dest: string,
  hiddenTestFiles: readonly string[],
): Promise<string> {
  if (hiddenTestFiles.length === 0) throw new Error("No hidden test files to install");
  const dir = path.join(dest, HIDDEN_TESTS_DIR_IN_TARGET);
  await mkdir(dir, { recursive: true });
  await copyFile(HIDDEN_HARNESS_FILE, path.join(dir, path.basename(HIDDEN_HARNESS_FILE)));
  for (const file of hiddenTestFiles) {
    await copyFile(file, path.join(dir, path.basename(file)));
  }
  return HIDDEN_TESTS_DIR_IN_TARGET;
}
