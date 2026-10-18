import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { succeeded, type CommandResult } from "../process/run-command.js";
import { ensureSandboxImage, runInSandbox, type SandboxProfile } from "../quality/sandbox.js";
import { splitCommand } from "../schemas/project.js";
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
import { parseVitestCases, type VitestCase } from "./hidden-tests.js";
import type { EvalStand } from "./stand.js";

/** Runs a command against a prepared copy of the target repo. */
export type CheckRunner = (
  cwd: string,
  command: readonly string[],
  timeoutMs: number,
) => Promise<CommandResult>;

/** Default runner: the Docker sandbox. Sandbox infrastructure failures abort verification. */
export async function sandboxRunner(target: string, profile: SandboxProfile): Promise<CheckRunner> {
  const image = await ensureSandboxImage(target, profile);
  return async (cwd, command, timeoutMs) => {
    const res = await runInSandbox(cwd, command, timeoutMs, { image });
    if (res.infraError !== undefined) throw new Error(res.infraError);
    return res;
  };
}

const STEP_TIMEOUT_MS = 5 * 60_000;

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

/** Hidden tests for repository rules live in files with this suffix. */
export const RULES_FILE_SUFFIX = ".rules.hidden.test.ts";
/** A rules test with this title prefix guards existing behavior: it must pass on baseline. */
export const GUARD_PREFIX = "[guard]";

/**
 * Per-test rule for repository-rule tests, checked on the baseline run:
 * - implemented task: every rules test fails on baseline, except `[guard]` tests, which pass;
 * - needs_clarification task: every rules test is a `[guard]` test and passes.
 * A skipped or todo test is never accepted. Other hidden files keep the per-task rule only.
 * Returns one line per offending test (empty = valid).
 */
export function rulesTestIssues(
  expected: ExpectedOutcome,
  baseline: readonly VitestCase[],
): string[] {
  const issues: string[] = [];
  for (const t of baseline.filter((c) => c.file.endsWith(RULES_FILE_SUFFIX))) {
    const guard = t.title.startsWith(GUARD_PREFIX);
    const name = `${t.file}: "${t.title}"`;
    if (t.status !== "passed" && t.status !== "failed") {
      issues.push(`${name} is ${t.status} on baseline (hidden tests must not be skipped)`);
    } else if (expected === "needs_clarification" && !guard) {
      issues.push(`${name} must be a ${GUARD_PREFIX} test (clarification task)`);
    } else if (guard && t.status !== "passed") {
      issues.push(`${name} is a guard but fails on baseline`);
    } else if (!guard && t.status !== "failed") {
      issues.push(`${name} passes on baseline — it tests nothing new (mark it ${GUARD_PREFIX}?)`);
    }
  }
  return issues;
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
  opts: { stand: EvalStand; runner?: CheckRunner; dirs?: EvalDirs },
): Promise<TaskVerification> {
  const dirs = opts.dirs ?? DEFAULT_EVAL_DIRS;
  const { stand } = opts;
  const target = stand.fixtureDir;
  const runner =
    opts.runner ??
    (await sandboxRunner(target, {
      image: stand.projectConfig.profile.image,
      dependencyFiles: stand.projectConfig.profile.dependency_files,
    }));
  const hiddenOnly = (dir: string) => ["sh", "-c", stand.hidden.script, "sh", dir];
  const fullCheck = splitCommand(stand.hidden.reference_check) ?? [];

  await loadTaskSpec(taskId, dirs); // validates task.yaml
  const meta = await loadEvalMeta(taskId, dirs);
  const hiddenFiles = await listHiddenTestFiles(taskId, dirs);
  const patch = referencePatchPath(taskId, dirs);
  const hasPatch = await exists(patch);

  const workRoot = await mkdtemp(path.join(os.tmpdir(), `factory-verify-${taskId}-`));
  try {
    const baseDir = path.join(workRoot, "baseline");
    await prepareTargetCopy({ source: target, dest: baseDir });
    const hiddenDir = await installHiddenTests(baseDir, hiddenFiles, stand.hidden.dir);
    const baseline = await runner(baseDir, hiddenOnly(hiddenDir), STEP_TIMEOUT_MS);

    let reference: CommandResult | null = null;
    if (hasPatch) {
      const refDir = path.join(workRoot, "reference");
      await prepareTargetCopy({ source: target, dest: refDir });
      await applyPatch(refDir, patch);
      await installHiddenTests(refDir, hiddenFiles, stand.hidden.dir);
      reference = await runner(refDir, fullCheck, STEP_TIMEOUT_MS);
    }

    const taskOutcome = evaluateVerification({
      expected: meta.expected_outcome,
      baselinePassed: succeeded(baseline),
      referencePassed: reference === null ? null : succeeded(reference),
    });
    const cases = parseVitestCases(baseline.stdout);
    const ruleIssues =
      cases === null
        ? ["could not parse Vitest's JSON report of the baseline run"]
        : rulesTestIssues(meta.expected_outcome, cases);
    const outcome: VerificationOutcome =
      ruleIssues.length === 0
        ? taskOutcome
        : {
            ok: false,
            reason: [
              ...(taskOutcome.ok ? [] : [taskOutcome.reason]),
              `rules tests: ${ruleIssues.join("; ")}`,
            ].join("; "),
          };
    return { taskId, expected: meta.expected_outcome, baseline, reference, ...outcome };
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}
