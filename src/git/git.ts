import { runCommand } from "../process/run-command.js";

/**
 * Git invocations made by the factory (never by agents). A fixed identity and disabled
 * hooks/signing make commits deterministic and keep a target repo's hooks from running.
 */
const GIT_CONFIG = [
  "-c",
  "user.name=Agentic Factory",
  "-c",
  "user.email=factory@localhost",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.autocrlf=false",
  // Runs of one project work in parallel worktrees; no automatic gc in the middle of them.
  "-c",
  "gc.auto=0",
];

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} failed: ${stderr.trim()}`);
    this.name = "GitError";
  }
}

/** Runs git and returns stdout. Throws GitError on failure (git failures are infrastructure errors). */
export async function git(
  cwd: string,
  args: readonly string[],
  timeoutMs = 120_000,
): Promise<string> {
  const res = await runCommand("git", [...GIT_CONFIG, ...args], { cwd, timeoutMs });
  if (res.exitCode !== 0 || res.timedOut) {
    throw new GitError(args, res.timedOut ? "timed out" : res.stderr || res.spawnError || "");
  }
  return res.stdout;
}
