import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { git } from "../git/git.js";
import {
  ensureHostDeps,
  exportTree,
  type ProjectSource,
  type TargetRepo,
} from "../git/target-repo.js";
import type { SandboxExec } from "../quality/gate.js";
import { tailLines } from "../quality/gate.js";
import { SANDBOX_DIR, type SandboxProfile } from "../quality/sandbox.js";
import { profileChecks, splitCommand, type ProjectConfig } from "../schemas/project.js";
import { readProjectConfig, showFile } from "./projects.js";

export interface CheckLine {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ProjectCheckDeps {
  ensureRepo: (project: ProjectSource) => Promise<TargetRepo>;
  /** Builds (or finds) the sandbox image and returns an executor for it. */
  sandbox: (
    repoDir: string,
    profile: SandboxProfile,
  ) => Promise<{ tag: string; exec: SandboxExec }>;
  checkTimeoutMs: number;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * `npm run project:check -- <projectId>`: is the project ready for the factory? Checks, in
 * order: the config at the target branch (as committed), the files it names, the sandbox
 * profile and image, the host dependency install, and that every gate check passes on a clean
 * export of the target branch in the sandbox. No agent is called. Stops at the first failure
 * that makes the later checks meaningless.
 */
export async function checkProject(
  project: ProjectSource,
  deps: ProjectCheckDeps,
): Promise<CheckLine[]> {
  const lines: CheckLine[] = [];
  const add = (name: string, ok: boolean, detail: string) => {
    lines.push({ name, ok, detail });
    return ok;
  };

  let repo: TargetRepo;
  try {
    repo = await deps.ensureRepo(project);
  } catch (err) {
    add("repository", false, err instanceof Error ? err.message : String(err));
    return lines;
  }
  const branch = (await git(repo.dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  add("repository", true, `${repo.dir} (${branch} at ${repo.baseCommit.slice(0, 12)})`);

  let config: ProjectConfig;
  let commit: string;
  try {
    ({ config, commit } = await readProjectConfig(repo.dir, "HEAD"));
  } catch (err) {
    add("config", false, err instanceof Error ? err.message : String(err));
    return lines;
  }
  add("config", true, `.factory/config.yaml valid at ${commit.slice(0, 12)}`);
  if (
    !add(
      "target branch",
      branch === config.target_branch,
      `checked out ${branch}, target_branch ${config.target_branch}`,
    )
  )
    return lines;

  const missing: string[] = [];
  for (const f of [config.conventions_file, ...config.profile.dependency_files]) {
    if ((await showFile(repo.dir, commit, f)) === null) missing.push(f);
  }
  add(
    "files",
    missing.length === 0,
    missing.length
      ? `not committed: ${missing.join(", ")}`
      : `conventions ${config.conventions_file} and dependency files committed`,
  );

  const profileDir = path.join(SANDBOX_DIR, config.profile.image);
  const hasProfile =
    (await exists(path.join(profileDir, "Dockerfile"))) &&
    (await exists(path.join(profileDir, "bootstrap.sh")));
  if (
    !add(
      "sandbox profile",
      hasProfile,
      `sandbox/${config.profile.image}/ ${hasProfile ? "found" : "missing Dockerfile or bootstrap.sh"}`,
    )
  )
    return lines;
  if (missing.length > 0) return lines;

  let exec: SandboxExec;
  try {
    const sb = await deps.sandbox(repo.dir, {
      image: config.profile.image,
      dependencyFiles: config.profile.dependency_files,
    });
    exec = sb.exec;
    add("sandbox image", true, sb.tag);
  } catch (err) {
    add("sandbox image", false, err instanceof Error ? err.message : String(err));
    return lines;
  }

  try {
    await ensureHostDeps(repo.dir, {
      install: splitCommand(config.profile.install) ?? [],
      hostDepsDir: config.profile.host_deps_dir,
    });
    add(
      "host install",
      true,
      `${config.profile.host_deps_dir}/ present (${config.profile.install})`,
    );
  } catch (err) {
    add("host install", false, err instanceof Error ? err.message : String(err));
  }

  // The gate's checks on a clean export of the target branch (no working-tree state).
  const root = await mkdtemp(path.join(os.tmpdir(), `factory-project-check-${project.id}-`));
  try {
    const tree = path.join(root, "tree");
    await mkdir(tree);
    await exportTree(repo.dir, commit, tree);
    for (const check of profileChecks(config)) {
      const res = await exec(tree, check.command, deps.checkTimeoutMs);
      const ok = res.infraError === undefined && res.exitCode === 0 && !res.timedOut;
      add(
        `check ${check.name}`,
        ok,
        ok
          ? `${check.command.join(" ")}: exit 0 (${Math.round(res.durationMs / 100) / 10}s)`
          : `${check.command.join(" ")}: ${res.infraError ?? (res.timedOut ? "timed out" : `exit ${res.exitCode ?? "?"}`)}\n${tailLines(`${res.stdout}\n${res.stderr}`, 20)}`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  return lines;
}
