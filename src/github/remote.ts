import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../process/run-command.js";
import { createRedactor } from "../store/redact.js";

/*
 * Git operations against a project's remote (GitHub), done by the factory only, never by
 * agents. Authentication goes through gh's credential helper (`gh auth git-credential`,
 * gh 2.102.0) with GH_TOKEN in an explicit env: the token is never written to .git/config,
 * a URL or a log, and the owner's own credential helpers are disabled (`credential.helper=`
 * first resets the list). For a local path remote (tests) no credentials are asked for.
 */

export type PushResult = { ok: true } | { ok: false; rejected: boolean; message: string };

export interface RemoteGit {
  clone(url: string, dir: string): Promise<void>;
  /** Fetches `branch` from origin. */
  fetch(repoDir: string, branch: string): Promise<void>;
  /** Pushes `commit` to `refs/heads/<branch>` on origin, never forced. */
  push(repoDir: string, commit: string, branch: string): Promise<PushResult>;
}

export function ghRemote(opts: {
  token: string | null;
  ghBin?: string;
  timeoutMs?: number;
}): RemoteGit {
  const configDir = mkdtempSync(path.join(os.tmpdir(), "factory-git-remote-"));
  const redact = createRedactor(opts.token ? [opts.token] : []);
  const env: Record<string, string> = {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: configDir,
    GH_CONFIG_DIR: configDir,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    ...(opts.token ? { GH_TOKEN: opts.token } : {}),
  };
  const helper = `!${opts.ghBin ?? "gh"} auth git-credential`;
  const git = async (cwd: string, args: string[]) => {
    const res = await runCommand(
      "git",
      [
        "-c",
        "credential.helper=",
        "-c",
        `credential.helper=${helper}`,
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      { cwd, env, timeoutMs: opts.timeoutMs ?? 10 * 60_000 },
    );
    return {
      ok: res.exitCode === 0 && !res.timedOut,
      out: redact(`${res.stdout}\n${res.stderr}`.trim()),
    };
  };
  return {
    async clone(url, dir) {
      const res = await git(path.dirname(dir), [
        "clone",
        "-q",
        "--no-recurse-submodules",
        url,
        dir,
      ]);
      if (!res.ok) throw new Error(`git clone ${url} failed: ${res.out}`);
    },
    async fetch(repoDir, branch) {
      const res = await git(repoDir, [
        "fetch",
        "-q",
        "origin",
        `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
      ]);
      if (!res.ok) throw new Error(`git fetch origin ${branch} failed: ${res.out}`);
    },
    async push(repoDir, commit, branch) {
      const res = await git(repoDir, ["push", "-q", "origin", `${commit}:refs/heads/${branch}`]);
      if (res.ok) return { ok: true };
      return {
        ok: false,
        rejected: /\[rejected\]|non-fast-forward|fetch first|stale info/.test(res.out),
        message: res.out,
      };
    },
  };
}
