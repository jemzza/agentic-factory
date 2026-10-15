import os from "node:os";
import { describe, expect, it } from "vitest";
import { runCommand, succeeded } from "./run-command.js";

const cwd = os.tmpdir();
const node = process.execPath;

describe("runCommand", () => {
  it("captures stdout, stderr and a zero exit code", async () => {
    const res = await runCommand(
      node,
      ["-e", "process.stdout.write('out'); process.stderr.write('err')"],
      { cwd, timeoutMs: 10_000 },
    );
    expect(res).toMatchObject({ exitCode: 0, stdout: "out", stderr: "err", timedOut: false });
    expect(succeeded(res)).toBe(true);
  });

  it("reports a non-zero exit code without throwing", async () => {
    const res = await runCommand(node, ["-e", "process.exit(3)"], { cwd, timeoutMs: 10_000 });
    expect(res.exitCode).toBe(3);
    expect(succeeded(res)).toBe(false);
  });

  it("kills the process on timeout and reports timedOut", async () => {
    const res = await runCommand(node, ["-e", "setInterval(() => {}, 1000)"], {
      cwd,
      timeoutMs: 300,
    });
    expect(res.timedOut).toBe(true);
    expect(succeeded(res)).toBe(false);
    expect(res.durationMs).toBeLessThan(5_000);
  });

  it("reports a missing binary as a spawn error", async () => {
    const res = await runCommand("definitely-not-a-real-binary-xyz", [], {
      cwd,
      timeoutMs: 10_000,
    });
    expect(res.exitCode).toBeNull();
    expect(res.spawnError).toBeDefined();
    expect(succeeded(res)).toBe(false);
  });

  it("does not inherit the host environment when env is given", async () => {
    process.env["FACTORY_TEST_SECRET"] = "leak";
    try {
      const res = await runCommand(
        node,
        ["-e", "process.stdout.write(String(process.env.FACTORY_TEST_SECRET))"],
        { cwd, timeoutMs: 10_000, env: { ONLY: "this" } },
      );
      expect(res.stdout).toBe("undefined");
    } finally {
      delete process.env["FACTORY_TEST_SECRET"];
    }
  });

  it("passes input on stdin", async () => {
    const res = await runCommand(node, ["-e", "process.stdin.pipe(process.stdout)"], {
      cwd,
      timeoutMs: 10_000,
      input: "hello",
    });
    expect(res.stdout).toBe("hello");
  });
});
