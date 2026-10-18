import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FACTORY_ROOT } from "../paths.js";
import { runCommand, type CommandResult } from "../process/run-command.js";
import { hostSuspendedMessage } from "../runtimes/provider-errors.js";

/** Sandbox profiles: `sandbox/<image>/{Dockerfile,bootstrap.sh}` (one per stack). */
export const SANDBOX_DIR = path.join(FACTORY_ROOT, "sandbox");
/** Path of the profile's bootstrap script inside the image. */
export const BOOTSTRAP_IN_IMAGE = "/opt/factory/bootstrap.sh";

/** What the sandbox needs from a project's profile to build and run its image. */
export interface SandboxProfile {
  /** Profile directory name under sandbox/. */
  image: string;
  /** Repo-relative files that define the dependency set (copied to deps/ in the context). */
  dependencyFiles: readonly string[];
}

const profileFiles = (image: string) => {
  if (!/^[a-z][a-z0-9-]*$/.test(image)) throw new Error(`invalid sandbox profile "${image}"`);
  const dir = path.join(SANDBOX_DIR, image);
  return { dockerfile: path.join(dir, "Dockerfile"), bootstrap: path.join(dir, "bootstrap.sh") };
};

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
  /** The check timed out while the host was suspended (sleep): infrastructure, not a result. */
  hostSuspended?: boolean;
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
 * Image tag derived from the profile's Dockerfile and bootstrap script and the project's
 * dependency files (paths and bytes): a lockfile change produces a new image.
 */
export async function sandboxImageTag(repoDir: string, profile: SandboxProfile): Promise<string> {
  const files = profileFiles(profile.image);
  const hash = createHash("sha256");
  hash.update(await readFile(files.dockerfile));
  hash.update("\0bootstrap\0");
  hash.update(await readFile(files.bootstrap));
  for (const file of profile.dependencyFiles) {
    hash.update(`\0${file}\0`);
    hash.update(await readFile(path.join(repoDir, file)));
  }
  return `agentic-factory-${profile.image}:${hash.digest("hex").slice(0, 12)}`;
}

/**
 * Returns the sandbox image tag for a project, building it if missing. The build context
 * is a temp dir with only the profile's Dockerfile and bootstrap script and the project's
 * dependency files under deps/, so no source code, secrets, or host dependency directories
 * ever reach the image. Building needs network (installing dependencies).
 */
export async function ensureSandboxImage(
  repoDir: string,
  profile: SandboxProfile,
): Promise<string> {
  const tag = await sandboxImageTag(repoDir, profile);
  const inspect = await runCommand("docker", ["image", "inspect", tag], {
    cwd: FACTORY_ROOT,
    timeoutMs: 30_000,
  });
  if (inspect.exitCode === 0) return tag;
  if (inspect.spawnError) throw new Error(`docker is not available: ${inspect.spawnError}`);

  const files = profileFiles(profile.image);
  const context = await mkdtemp(path.join(os.tmpdir(), "factory-sandbox-build-"));
  try {
    await copyFile(files.dockerfile, path.join(context, "Dockerfile"));
    await copyFile(files.bootstrap, path.join(context, "bootstrap.sh"));
    for (const file of profile.dependencyFiles) {
      const dest = path.join(context, "deps", file);
      await mkdir(path.dirname(dest), { recursive: true });
      await copyFile(path.join(repoDir, file), dest);
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
  /** Run that owns the container (label `agentic-factory.run=<runId>`, for cleanup). */
  runId?: string;
}): string[] {
  const l = opts.limits ?? DEFAULT_LIMITS;
  return [
    "run",
    "--rm",
    "--name",
    opts.containerName,
    "--label",
    "agentic-factory=check",
    ...(opts.runId ? ["--label", `agentic-factory.run=${opts.runId}`] : []),
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
    BOOTSTRAP_IN_IMAGE,
    ...opts.command,
  ];
}

/** Docker container name for a run step; only [a-zA-Z0-9_.-] (Docker's name rule). */
export function containerNameFor(runId: string, step: string): string {
  return `factory-${runId}-${step}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

/**
 * Removes every container a run left behind (e.g. after a crash mid-check), by its label.
 * Docker unavailable is not an error here: the next check reports it.
 */
export async function removeRunContainers(runId: string): Promise<number> {
  const list = await runCommand(
    "docker",
    ["ps", "-aq", "--filter", `label=agentic-factory.run=${runId}`],
    { cwd: FACTORY_ROOT, timeoutMs: 30_000 },
  );
  const ids = list.exitCode === 0 ? list.stdout.split("\n").filter((x) => x.trim() !== "") : [];
  if (ids.length) {
    await runCommand("docker", ["rm", "-f", ...ids], { cwd: FACTORY_ROOT, timeoutMs: 60_000 });
  }
  return ids.length;
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
  opts: { image: string; limits?: SandboxLimits; tag?: { runId: string; step: string } },
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

  // One name per run step (`factory-<runId>-<step>`), so parallel runs never collide and a
  // leftover from a crashed attempt of the same step is removed first.
  const containerName = opts.tag
    ? containerNameFor(opts.tag.runId, opts.tag.step)
    : `factory-check-${randomBytes(6).toString("hex")}`;
  if (opts.tag) {
    await runCommand("docker", ["rm", "-f", containerName], {
      cwd: worktreePath,
      timeoutMs: 30_000,
    });
  }
  const args = buildDockerRunArgs({
    image: opts.image,
    containerName,
    worktreePath,
    command,
    ...(opts.limits ? { limits: opts.limits } : {}),
    ...(opts.tag ? { runId: opts.tag.runId } : {}),
  });

  const result: CommandResult = await runCommand("docker", args, {
    cwd: worktreePath,
    timeoutMs,
  });

  if (result.timedOut) {
    // Killing the docker CLI does not necessarily stop the container.
    await runCommand("docker", ["kill", containerName], { cwd: worktreePath, timeoutMs: 30_000 });
  }

  const suspended = result.timedOut ? hostSuspendedMessage(result) : null;
  const infraError =
    result.spawnError ??
    suspended ??
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
    ...(suspended ? { hostSuspended: true } : {}),
  };
}
