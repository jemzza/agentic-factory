import { execa } from "execa";
import { hostSuspend } from "./host-suspend.js";

export interface CommandResult {
  /** Process exit code; `null` if it was killed by a signal or never started. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /** Set when the process could not be spawned (e.g. binary not found). */
  spawnError?: string;
  /** Time the host was suspended (sleep) while the command ran; absent if none. */
  suspendedMs?: number;
}

export interface RunCommandOptions {
  cwd: string;
  timeoutMs: number;
  /** Environment for the child. When given, the host environment is NOT inherited. */
  env?: Record<string, string>;
  input?: string;
  /**
   * Run the child in its own process group and, on timeout, kill the whole group
   * (SIGTERM, then SIGKILL). Use for processes that spawn their own children
   * (e.g. an agent running `npm test`), so nothing outlives the timeout. POSIX only.
   */
  killTree?: boolean;
}

/** Grace period between SIGTERM and SIGKILL after a timeout. */
const FORCE_KILL_AFTER_MS = 5_000;

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Group already gone.
  }
}

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
  const startedWall = Date.now();
  const killTree = options.killTree === true;
  const subprocess = execa(file, args, {
    cwd: options.cwd,
    reject: false,
    stripFinalNewline: false,
    ...(killTree
      ? { detached: true }
      : { timeout: options.timeoutMs, forceKillAfterDelay: FORCE_KILL_AFTER_MS }),
    ...(options.env ? { env: options.env, extendEnv: false } : {}),
    ...(options.input !== undefined ? { input: options.input } : { stdin: "ignore" }),
  });

  let groupTimedOut = false;
  const timers: NodeJS.Timeout[] = [];
  const pid = subprocess.pid;
  if (killTree && pid !== undefined) {
    timers.push(
      setTimeout(() => {
        groupTimedOut = true;
        killGroup(pid, "SIGTERM");
        timers.push(
          setTimeout(() => {
            killGroup(pid, "SIGKILL");
          }, FORCE_KILL_AFTER_MS),
        );
      }, options.timeoutMs),
    );
  }

  const result = await subprocess;
  for (const t of timers) clearTimeout(t);
  if (killTree && pid !== undefined) killGroup(pid, "SIGKILL"); // reap stragglers

  const timedOut = killTree ? groupTimedOut : result.timedOut;
  const spawnError =
    result.failed && result.exitCode === undefined && !timedOut && !result.isTerminated
      ? result.shortMessage
      : undefined;
  const suspendedMs = hostSuspend.suspendedWithin(startedWall, Date.now());
  return {
    exitCode: result.exitCode ?? null,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    durationMs: Math.round(performance.now() - started),
    timedOut,
    ...(spawnError !== undefined ? { spawnError } : {}),
    ...(suspendedMs > 0 ? { suspendedMs } : {}),
  };
}

export function succeeded(result: CommandResult): boolean {
  return result.exitCode === 0 && !result.timedOut;
}
