import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FIXTURES_DIR } from "../paths.js";
import { runCommand, succeeded, type CommandResult } from "../process/run-command.js";
import type { ExpectedOutcome } from "../schemas/task.js";
import {
  DEFAULT_EVAL_DIRS,
  listHiddenTestFiles,
  loadEvalMeta,
  loadTaskSpec,
  referencePatchPath,
  type EvalDirs,
} from "./tasks.js";
import { applyPatch, installHiddenTests, prepareTargetCopy } from "./target-copy.js";

/**
 * Runs a command inside a prepared copy of the target repo. Phase 3 uses the host;
 * Phase 4 swaps in the Docker sandbox with the same signature.
 */
export type CheckRunner = (
  cwd: string,
  command: readonly string[],
  timeoutMs: number,
) => Promise<CommandResult>;

export const hostRunner: CheckRunner = (cwd, [file, ...args], timeoutMs) => {
  if (file === undefined) throw new Error("empty command");
  return runCommand(file, args, { cwd, timeoutMs });
};

const STEP_TIMEOUT_MS = 5 * 60_000;
const HIDDEN_ONLY = (dir: string) => ["node_modules/.bin/vitest", "run", dir];
const FULL_CHECK = ["npm", "run", "check"];

export interface VerificationOutcome {
  ok: boolean;
  reason: string;
}

/**
 * Hidden tests are valid when:
 * - implemented: they FAIL on the baseline and the reference passes the full check
 *   (typecheck + existing tests + hidden tests);
 * - needs_clarification: they PASS on the baseline (they guard existing behavior)
 *   and there is no reference patch.
 */
export function evaluateVerification(input: {
  expected: ExpectedOutcome;
  baselinePassed: boolean;
  referencePassed: boolean | null;
}): VerificationOutcome {
  if (input.expected === "needs_clarification") {
    if (input.referencePassed !== null) {
      return { ok: false, reason: "clarification task must not have a reference patch" };
    }
    return input.baselinePassed
      ? { ok: true, reason: "hidden tests pass on baseline (existing behavior guarded)" }
      : { ok: false, reason: "hidden tests should pass on baseline but fail" };
  }
  if (input.baselinePassed)
    return { ok: false, reason: "hidden tests pass on baseline — they test nothing new" };
  if (input.referencePassed === null) return { ok: false, reason: "reference patch is missing" };
  if (!input.referencePassed)
    return { ok: false, reason: "reference implementation fails the check" };
  return { ok: true, reason: "fail on baseline, pass on reference" };
}

export interface TaskVerification extends VerificationOutcome {
  taskId: string;
  expected: ExpectedOutcome;
  baseline: CommandResult;
  reference: CommandResult | null;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export async function verifyHiddenTests(
  taskId: string,
  opts: { target?: string; runner?: CheckRunner; dirs?: EvalDirs } = {},
): Promise<TaskVerification> {
  const dirs = opts.dirs ?? DEFAULT_EVAL_DIRS;
  const runner = opts.runner ?? hostRunner;
  const target = opts.target ?? path.join(FIXTURES_DIR, "taskflow");

  await loadTaskSpec(taskId, dirs); // validates task.yaml
  const meta = await loadEvalMeta(taskId, dirs);
  const hiddenFiles = await listHiddenTestFiles(taskId, dirs);
  const patch = referencePatchPath(taskId, dirs);
  const hasPatch = await exists(patch);

  const workRoot = await mkdtemp(path.join(os.tmpdir(), `factory-verify-${taskId}-`));
  try {
    const baseDir = path.join(workRoot, "baseline");
    await prepareTargetCopy({ source: target, dest: baseDir, nodeModulesFrom: target });
    const hiddenDir = await installHiddenTests(baseDir, hiddenFiles);
    const baseline = await runner(baseDir, HIDDEN_ONLY(hiddenDir), STEP_TIMEOUT_MS);

    let reference: CommandResult | null = null;
    if (hasPatch) {
      const refDir = path.join(workRoot, "reference");
      await prepareTargetCopy({ source: target, dest: refDir, nodeModulesFrom: target });
      await applyPatch(refDir, patch);
      await installHiddenTests(refDir, hiddenFiles);
      reference = await runner(refDir, FULL_CHECK, STEP_TIMEOUT_MS);
    }

    const outcome = evaluateVerification({
      expected: meta.expected_outcome,
      baselinePassed: succeeded(baseline),
      referencePassed: reference === null ? null : succeeded(reference),
    });
    return { taskId, expected: meta.expected_outcome, baseline, reference, ...outcome };
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}
