import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FACTORY_ROOT } from "../paths.js";
import { runCommand, type CommandResult } from "../process/run-command.js";

export const SANDBOX_DOCKERFILE = path.join(FACTORY_ROOT, "sandbox", "Dockerfile");
const IMAGE_REPO = "agentic-factory-sandbox";

/** Files from the target repo that determine the sandbox image (its dependency set). */
const DEPENDENCY_FILES = ["package.json", "package-lock.json"] as const;

export interface SandboxResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /**
   * Set when the sandbox itself failed (docker unavailable, bad mount, ...), as opposed to
   * the command inside it failing. Callers must not treat this as a check result.
   */
  infraError?: string;
}

export interface SandboxLimits {
  memory: string;
  cpus: string;
  pids: number;
  workSize: string;
  tmpSize: string;
}

export const DEFAULT_LIMITS: SandboxLimits = {
  memory: "2g",
  cpus: "2",
  pids: 512,
  workSize: "1g",
  tmpSize: "256m",
};

/**
 * Container-side bootstrap, run by `sh -c` before the actual command (passed as "$@"):
 * copy the read-only mounted worktree into the tmpfs at /work, then build a writable
 * /work/node_modules made of symlinks into the image's /deps/node_modules. It must be a
 * real directory because tools (vite/vitest) write temp files into node_modules.
 * Any node_modules from the host copy is discarded: host binaries are for another OS.
 */
export const BOOTSTRAP_SCRIPT = [
  "set -e",
  "cp -a /src/. /work/",
  "rm -rf /work/node_modules",
  "mkdir /work/node_modules",
  'for e in /deps/node_modules/* /deps/node_modules/.[!.]*; do [ -e "$e" ] && ln -s "$e" /work/node_modules/; done',
  'exec "$@"',
].join("\n");

/** Image tag derived from the Dockerfile and the target's dependency manifests. */
export async function sandboxImageTag(targetDir: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(SANDBOX_DOCKERFILE));
  for (const file of DEPENDENCY_FILES) {
    hash.update(`\0${file}\0`);
    hash.update(await readFile(path.join(targetDir, file)));
  }
  return `${IMAGE_REPO}:${hash.digest("hex").slice(0, 12)}`;
}

/**
 * Returns the sandbox image tag for a target, building it if missing. The build context
 * is a temp dir with only the Dockerfile and the dependency manifests, so no source code,
 * secrets, or host node_modules ever reach the image. Building needs network (npm ci).
 */
export async function ensureSandboxImage(targetDir: string): Promise<string> {
  const tag = await sandboxImageTag(targetDir);
  const inspect = await runCommand("docker", ["image", "inspect", tag], {
    cwd: FACTORY_ROOT,
    timeoutMs: 30_000,
  });
  if (inspect.exitCode === 0) return tag;
  if (inspect.spawnError) throw new Error(`docker is not available: ${inspect.spawnError}`);

  const context = await mkdtemp(path.join(os.tmpdir(), "factory-sandbox-build-"));
  try {
    await copyFile(SANDBOX_DOCKERFILE, path.join(context, "Dockerfile"));
    for (const file of DEPENDENCY_FILES) {
      await copyFile(path.join(targetDir, file), path.join(context, file));
    }
    const build = await runCommand(
      "docker",
      ["build", "--quiet", "--label", "agentic-factory=sandbox", "-t", tag, context],
      { cwd: context, timeoutMs: 15 * 60_000 },
    );
    if (build.exitCode !== 0) {
      throw new Error(`docker build failed (${tag}):\n${build.stderr || build.stdout}`);
    }
    return tag;
  } finally {
    await rm(context, { recursive: true, force: true });
  }
}

/** Builds the `docker run` argv. Pure, so the security flags are unit-testable. */
export function buildDockerRunArgs(opts: {
  image: string;
  containerName: string;
  worktreePath: string;
  command: readonly string[];
  limits?: SandboxLimits;
}): string[] {
  const l = opts.limits ?? DEFAULT_LIMITS;
  return [
    "run",
    "--rm",
    "--name",
    opts.containerName,
    "--label",
    "agentic-factory=check",
    // Isolation
    "--network",
    "none",
    "--read-only",
    "--user",
    "1000:1000",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    // Resource limits
    "--memory",
    l.memory,
    "--memory-swap",
    l.memory,
    "--cpus",
    l.cpus,
    "--pids-limit",
    String(l.pids),
    // Writable scratch space only in memory
    "--tmpfs",
    `/tmp:rw,exec,nosuid,size=${l.tmpSize}`,
    "--tmpfs",
    `/work:rw,exec,nosuid,size=${l.workSize},uid=1000,gid=1000,mode=0755`,
    // Code under test, read-only
    "--mount",
    `type=bind,src=${opts.worktreePath},dst=/src,readonly`,
    // The only environment the container gets: nothing from the host.
    "--env",
    "HOME=/tmp",
    "--env",
    "CI=1",
    "--env",
    "NO_COLOR=1",
    "--env",
    "FORCE_COLOR=0",
    "--workdir",
    "/work",
    opts.image,
    "sh",
    "-c",
    BOOTSTRAP_SCRIPT,
    "sh",
    ...opts.command,
  ];
}

/** docker run's own failure (daemon down, bad flags, ...) — not the command's exit code. */
const DOCKER_RUN_ERROR_EXIT = 125;

/**
 * Runs `command` (argv, no shell) against a copy of `worktreePath` inside the sandbox:
 * no network, no host environment, read-only rootfs, non-root, resource-limited.
 * The worktree itself is mounted read-only and never modified.
 */
export async function runInSandbox(
  worktreePath: string,
  command: readonly string[],
  timeoutMs: number,
  opts: { image: string; limits?: SandboxLimits },
): Promise<SandboxResult> {
  if (command.length === 0) throw new Error("runInSandbox: empty command");
  if (!path.isAbsolute(worktreePath)) {
    throw new Error(`runInSandbox: worktree path must be absolute: ${worktreePath}`);
  }
  if (worktreePath.includes(",")) {
    throw new Error(`runInSandbox: unsupported character "," in path: ${worktreePath}`);
  }
  const info = await stat(worktreePath).catch(() => null);
  if (!info?.isDirectory()) {
    throw new Error(`runInSandbox: not a directory: ${worktreePath}`);
  }

  const containerName = `af-check-${randomBytes(6).toString("hex")}`;
  const args = buildDockerRunArgs({
    image: opts.image,
    containerName,
    worktreePath,
    command,
    ...(opts.limits ? { limits: opts.limits } : {}),
  });

  const result: CommandResult = await runCommand("docker", args, {
    cwd: worktreePath,
    timeoutMs,
  });

  if (result.timedOut) {
    // Killing the docker CLI does not necessarily stop the container.
    await runCommand("docker", ["kill", containerName], { cwd: worktreePath, timeoutMs: 30_000 });
  }

  const infraError =
    result.spawnError ??
    (result.exitCode === DOCKER_RUN_ERROR_EXIT
      ? `docker run failed: ${result.stderr.trim()}`
      : undefined);

  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    ...(infraError !== undefined ? { infraError } : {}),
  };
}
