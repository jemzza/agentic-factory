// Integration tests against a real Docker daemon. Run with `npm run test:sandbox`.
// The first run builds the TaskFlow sandbox image (needs network for npm ci).
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareTargetCopy } from "../../src/eval/target-copy.js";
import { runCommand } from "../../src/process/run-command.js";
import { ensureSandboxImage, runInSandbox } from "../../src/quality/sandbox.js";
import { loadEvalStand, type EvalStand } from "../../src/eval/stand.js";

// The eval stand's project (its fixture and sandbox profile).
let stand: EvalStand;
let TARGET: string;
let image: string;
let workRoot: string;
let worktree: string;

const run = (command: string[], timeoutMs = 120_000) =>
  runInSandbox(worktree, command, timeoutMs, { image });

beforeAll(async () => {
  stand = await loadEvalStand();
  TARGET = stand.fixtureDir;
  image = await ensureSandboxImage(TARGET, {
    image: stand.projectConfig.profile.image,
    dependencyFiles: stand.projectConfig.profile.dependency_files,
  });
  workRoot = await mkdtemp(path.join(os.tmpdir(), "factory-sandbox-it-"));
  worktree = path.join(workRoot, "wt");
  await prepareTargetCopy({ source: TARGET, dest: worktree });
}, 15 * 60_000);

afterAll(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

describe("runInSandbox (docker)", () => {
  it("runs the target's typecheck and tests offline with preinstalled deps", async () => {
    const res = await run(["npm", "run", "check"]);
    expect(res.infraError).toBeUndefined();
    expect(res.exitCode, res.stdout + res.stderr).toBe(0);
    expect(res.stdout).toMatch(/Tests\s+39 passed/);
  });

  it("reports a failing command's exit code", async () => {
    const res = await run(["sh", "-c", "exit 7"]);
    expect(res).toMatchObject({ exitCode: 7, timedOut: false });
    expect(res.infraError).toBeUndefined();
  });

  it("has no network", async () => {
    const res = await run([
      "node",
      "-e",
      "require('http').get('http://1.1.1.1',()=>process.exit(0)).on('error',()=>process.exit(42))",
    ]);
    expect(res.exitCode).toBe(42);
  });

  it("does not see host environment variables", async () => {
    process.env["FACTORY_IT_SECRET"] = "should-not-leak";
    try {
      const res = await run(["sh", "-c", "env"]);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).not.toContain("should-not-leak");
      expect(res.stdout).not.toContain("ANTHROPIC");
    } finally {
      delete process.env["FACTORY_IT_SECRET"];
    }
  });

  it("runs as an unprivileged user with a read-only root and read-only source mount", async () => {
    const res = await run([
      "sh",
      "-c",
      "id -u; touch /etc/x 2>/dev/null && echo ETC_WRITABLE; touch /src/x 2>/dev/null && echo SRC_WRITABLE; touch /deps/x 2>/dev/null && echo DEPS_WRITABLE; true",
    ]);
    expect(res.stdout.trim()).toBe("1000");
  });

  it("never modifies the mounted worktree", async () => {
    const before = await readdir(worktree);
    const marker = path.join(worktree, "package.json");
    const original = await readFile(marker, "utf8");
    await writeFile(marker, original); // ensure readable
    const res = await run(["sh", "-c", "echo hacked > /work/package.json && rm -rf /work/src"]);
    expect(res.exitCode).toBe(0);
    expect(await readdir(worktree)).toEqual(before);
    expect(await readFile(marker, "utf8")).toBe(original);
  });

  it("kills the process and the container on timeout", async () => {
    const res = await run(["sleep", "60"], 5_000);
    expect(res.timedOut).toBe(true);
    expect(res.durationMs).toBeLessThan(30_000);
    const ps = await runCommand(
      "docker",
      ["ps", "-q", "--filter", "label=agentic-factory=check", "--filter", "ancestor=" + image],
      { cwd: workRoot, timeoutMs: 30_000 },
    );
    expect(ps.stdout.trim()).toBe("");
  }, 60_000);

  it("reports a docker-level failure as infraError", async () => {
    const res = await runInSandbox(worktree, ["true"], 60_000, {
      image: "agentic-factory-sandbox:does-not-exist",
    });
    expect(res.infraError).toBeDefined();
  });
});

describe("runHiddenTests (docker)", () => {
  it("fails on the baseline and passes on the reference, without touching the source", async () => {
    const { runHiddenTests } = await import("../../src/eval/hidden-tests.js");
    const { applyPatch } = await import("../../src/eval/target-copy.js");
    const { referencePatchPath } = await import("../../src/eval/tasks.js");
    const { findHiddenArtifacts } = await import("../../src/eval/hidden-guard.js");
    const exec = (wt: string, cmd: readonly string[], t: number) =>
      runInSandbox(wt, cmd, t, { image });

    const baseline = await runHiddenTests({
      worktreePath: worktree,
      taskId: "complete-task",
      exec,
      timeoutMs: 120_000,
      hidden: stand.hidden,
    });
    expect(baseline).toMatchObject({ passed: false, total: 9, failed: 7 });
    expect(baseline.outputTail).toMatch(/✗ hidden: complete-task/);

    const ref = path.join(workRoot, "ref");
    await prepareTargetCopy({ source: TARGET, dest: ref });
    await applyPatch(ref, referencePatchPath("complete-task"));
    const passed = await runHiddenTests({
      worktreePath: ref,
      taskId: "complete-task",
      exec,
      timeoutMs: 120_000,
      hidden: stand.hidden,
    });
    expect(passed).toMatchObject({ passed: true, total: 9, failed: 0 });

    expect(await findHiddenArtifacts(ref)).toEqual([]);
    expect(await findHiddenArtifacts(worktree)).toEqual([]);
  });
});
