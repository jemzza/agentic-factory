import { describe, expect, it } from "vitest";
import { buildDockerRunArgs, runInSandbox } from "./sandbox.js";

function args(command: string[] = ["npm", "test"]) {
  return buildDockerRunArgs({
    image: "agentic-factory-sandbox:abc",
    containerName: "af-check-1",
    worktreePath: "/abs/worktree",
    command,
  });
}

/** Value following a flag, for every occurrence of the flag. */
function flagValues(argv: string[], flag: string): string[] {
  return argv.flatMap((a, i) => (a === flag ? [argv[i + 1] ?? ""] : []));
}

describe("buildDockerRunArgs", () => {
  it("disables the network and drops privileges", () => {
    const argv = args();
    expect(flagValues(argv, "--network")).toEqual(["none"]);
    expect(argv).toContain("--read-only");
    expect(flagValues(argv, "--user")).toEqual(["1000:1000"]);
    expect(flagValues(argv, "--cap-drop")).toEqual(["ALL"]);
    expect(flagValues(argv, "--security-opt")).toEqual(["no-new-privileges"]);
    expect(argv).not.toContain("--privileged");
  });

  it("sets resource limits and removes the container afterwards", () => {
    const argv = args();
    expect(argv).toContain("--rm");
    expect(flagValues(argv, "--memory")).toHaveLength(1);
    expect(flagValues(argv, "--cpus")).toHaveLength(1);
    expect(flagValues(argv, "--pids-limit")).toHaveLength(1);
  });

  it("mounts the worktree read-only and nothing else from the host", () => {
    const argv = args();
    expect(flagValues(argv, "--mount")).toEqual(["type=bind,src=/abs/worktree,dst=/src,readonly"]);
    expect(argv).not.toContain("-v");
    expect(argv).not.toContain("--volume");
  });

  it("passes only a fixed environment, never host variables", () => {
    const argv = args();
    expect(flagValues(argv, "--env")).toEqual(["HOME=/tmp", "CI=1", "NO_COLOR=1", "FORCE_COLOR=0"]);
    expect(argv).not.toContain("-e");
    expect(argv).not.toContain("--env-file");
  });

  it("passes the command as separate argv entries after the bootstrap (no shell interpolation)", () => {
    const argv = args(["npm", "run", "check; rm -rf /"]);
    expect(argv.slice(-3)).toEqual(["npm", "run", "check; rm -rf /"]);
    const imageIndex = argv.indexOf("agentic-factory-sandbox:abc");
    expect(argv.slice(imageIndex + 1, imageIndex + 3)).toEqual(["sh", "/opt/factory/bootstrap.sh"]);
  });
});

describe("runInSandbox input validation", () => {
  const opts = { image: "agentic-factory-sandbox:abc" };

  it("rejects relative worktree paths", async () => {
    await expect(runInSandbox("relative/path", ["true"], 1000, opts)).rejects.toThrow(/absolute/);
  });

  it("rejects an empty command", async () => {
    await expect(runInSandbox("/tmp", [], 1000, opts)).rejects.toThrow(/empty command/);
  });

  it("rejects paths that would break the --mount syntax", async () => {
    await expect(runInSandbox("/tmp/a,b", ["true"], 1000, opts)).rejects.toThrow(/","/);
  });

  it("rejects a missing directory", async () => {
    await expect(runInSandbox("/definitely/missing/dir", ["true"], 1000, opts)).rejects.toThrow(
      /not a directory/,
    );
  });
});
