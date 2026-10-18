import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Check } from "../schemas/config.js";
import type { CheckResult, GateResult } from "../schemas/report.js";
import { checkScope } from "./scope.js";
import type { SandboxResult } from "./sandbox.js";

export type SandboxExec = (
  worktreePath: string,
  command: readonly string[],
  timeoutMs: number,
) => Promise<SandboxResult>;

export class SandboxInfraError extends Error {
  constructor(
    message: string,
    /** The host slept during the check: the run ends as infra_error, not error. */
    readonly hostSuspended = false,
  ) {
    super(message);
    this.name = "SandboxInfraError";
  }
}

const TAIL_LINES = 80;

export function tailLines(text: string, lines = TAIL_LINES): string {
  const all = text.replace(/\s+$/, "").split("\n");
  return (all.length > lines ? ["…", ...all.slice(-lines)] : all).join("\n");
}

/**
 * Quality Gate, run by the factory (never the agent):
 * 1. scope — every changed file is inside `allowedPaths`, and something changed;
 * 2. each configured check runs in the sandbox (no network, no host env), in order.
 * All checks run even if an earlier one fails, so the developer gets complete feedback.
 * Sandbox infrastructure failures throw SandboxInfraError (not a check failure).
 */
export async function runGate(opts: {
  worktreePath: string;
  changedFiles: readonly string[];
  allowedPaths: readonly string[];
  checks: readonly Check[];
  checkTimeoutMs: number;
  /** Policy violations found by the caller (e.g. the approved spec was modified). */
  policyViolations?: readonly string[];
  exec: SandboxExec;
  logDir: string;
  logPrefix: string;
}): Promise<GateResult> {
  const scope = checkScope(opts.changedFiles, opts.allowedPaths);
  await mkdir(opts.logDir, { recursive: true });

  const checks: CheckResult[] = [];
  for (const check of opts.checks) {
    const res = await opts.exec(opts.worktreePath, check.command, opts.checkTimeoutMs);
    if (res.infraError !== undefined) {
      throw new SandboxInfraError(res.infraError, res.hostSuspended === true);
    }
    const output = `${res.stdout}${res.stderr ? `\n--- stderr ---\n${res.stderr}` : ""}`;
    const logPath = path.join(opts.logDir, `${opts.logPrefix}-${check.name}.log`);
    await writeFile(
      logPath,
      `$ ${check.command.join(" ")}\n# exit=${res.exitCode ?? "null"} timedOut=${res.timedOut} durationMs=${res.durationMs}\n\n${output}`,
    );
    checks.push({
      name: check.name,
      command: [...check.command],
      exitCode: res.exitCode,
      timedOut: res.timedOut,
      durationMs: res.durationMs,
      passed: res.exitCode === 0 && !res.timedOut,
      outputTail: tailLines(output),
      logPath,
    });
  }

  const policyViolations = [...(opts.policyViolations ?? [])];
  return {
    passed: scope.passed && policyViolations.length === 0 && checks.every((c) => c.passed),
    checks,
    scope,
    policyViolations,
  };
}

/** Human-readable gate failures for the developer's fix cycle. */
export function describeGateFailures(gate: GateResult): string {
  const parts: string[] = [];
  for (const p of gate.policyViolations) parts.push(`- Policy violation: ${p}`);
  if (gate.scope.empty) parts.push("- No files were changed. The task requires code changes.");
  for (const v of gate.scope.violations) {
    parts.push(`- Scope violation: \`${v}\` is outside the allowed paths. Revert changes to it.`);
  }
  for (const c of gate.checks.filter((c) => !c.passed)) {
    const why = c.timedOut ? "timed out" : `exit code ${c.exitCode ?? "null"}`;
    parts.push(
      `- Check \`${c.name}\` (\`${c.command.join(" ")}\`) failed (${why}). Output (tail):\n\n\`\`\`\n${c.outputTail}\n\`\`\``,
    );
  }
  return parts.join("\n");
}
