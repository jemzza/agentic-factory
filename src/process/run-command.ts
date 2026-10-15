import { execa } from "execa";

export interface CommandResult {
  /** Process exit code; `null` if it was killed by a signal or never started. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /** Set when the process could not be spawned (e.g. binary not found). */
  spawnError?: string;
}

export interface RunCommandOptions {
  cwd: string;
  timeoutMs: number;
  /** Environment for the child. When given, the host environment is NOT inherited. */
  env?: Record<string, string>;
  input?: string;
}

/** Grace period between SIGTERM and SIGKILL after a timeout. */
const FORCE_KILL_AFTER_MS = 5_000;

/**
 * Runs a command without a shell and never throws for expected failures:
 * non-zero exit, timeout, and spawn errors are reported in the result.
 */
export async function runCommand(
  file: string,
  args: readonly string[],
  options: RunCommandOptions,
): Promise<CommandResult> {
  const started = performance.now();
  const result = await execa(file, args, {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    forceKillAfterDelay: FORCE_KILL_AFTER_MS,
    reject: false,
    stripFinalNewline: false,
    ...(options.env ? { env: options.env, extendEnv: false } : {}),
    ...(options.input !== undefined ? { input: options.input } : { stdin: "ignore" }),
  });
  const spawnError =
    result.failed && result.exitCode === undefined && !result.timedOut && !result.isTerminated
      ? result.shortMessage
      : undefined;
  return {
    exitCode: result.exitCode ?? null,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    durationMs: Math.round(performance.now() - started),
    timedOut: result.timedOut,
    ...(spawnError !== undefined ? { spawnError } : {}),
  };
}

export function succeeded(result: CommandResult): boolean {
  return result.exitCode === 0 && !result.timedOut;
}
