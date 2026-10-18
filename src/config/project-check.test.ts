import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../git/git.js";
import type { SandboxExec } from "../quality/gate.js";
import { FAKE_PROJECT, FAKE_PROJECT_CONFIG_YAML, makeFakeRepo } from "../testing/fakes.js";
import { checkProject } from "./project-check.js";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "project-check-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const ok: SandboxExec = () =>
  Promise.resolve({ exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false });

async function run(exec: SandboxExec, files: Record<string, string> = {}) {
  const repo = await makeFakeRepo(path.join(tmp, "repo"), { "node_modules/.keep": "", ...files });
  const seen: string[][] = [];
  const lines = await checkProject(FAKE_PROJECT, {
    ensureRepo: () => Promise.resolve(repo),
    sandbox: () =>
      Promise.resolve({
        tag: "img:1",
        exec: (wt, cmd, t) => {
          seen.push([...cmd]);
          return exec(wt, cmd, t);
        },
      }),
    checkTimeoutMs: 1000,
  });
  return { lines, seen, repo };
}

describe("checkProject", () => {
  it("passes when the config is valid and every gate check exits 0 on the clean branch", async () => {
    const { lines, seen } = await run(ok);
    expect(lines.map((l) => [l.name, l.ok])).toEqual([
      ["repository", true],
      ["config", true],
      ["target branch", true],
      ["files", true],
      ["sandbox profile", true],
      ["sandbox image", true],
      ["host install", true],
      ["check typecheck", true],
      ["check test", true],
    ]);
    expect(seen).toEqual([
      ["npm", "run", "typecheck"],
      ["npm", "test"],
    ]);
  });

  it("fails on a failing check and shows its output", async () => {
    const { lines } = await run((_wt, cmd) =>
      Promise.resolve({
        exitCode: cmd.includes("test") ? 1 : 0,
        stdout: "FAIL tests/x.test.ts",
        stderr: "",
        durationMs: 1,
        timedOut: false,
      }),
    );
    const test = lines.find((l) => l.name === "check test");
    expect(test?.ok).toBe(false);
    expect(test?.detail).toMatch(/exit 1[\s\S]*FAIL tests\/x\.test\.ts/);
  });

  it("refuses an unknown sandbox profile and runs no checks", async () => {
    const { lines } = await run(ok, {
      ".factory/config.yaml": FAKE_PROJECT_CONFIG_YAML.replace(
        "image: node22",
        "image: no-such-profile",
      ),
    });
    expect(lines.find((l) => l.name === "sandbox profile")).toMatchObject({ ok: false });
    expect(lines.some((l) => l.name.startsWith("check "))).toBe(false);
  });

  it("refuses a clone that is not on the target branch, and an invalid config", async () => {
    const repo = await makeFakeRepo(path.join(tmp, "r2"));
    await git(repo.dir, ["checkout", "-q", "-b", "feature"]);
    const deps = {
      ensureRepo: () => Promise.resolve(repo),
      sandbox: () => Promise.resolve({ tag: "x", exec: ok }),
      checkTimeoutMs: 1000,
    };
    expect((await checkProject(FAKE_PROJECT, deps)).at(-1)).toMatchObject({
      name: "target branch",
      ok: false,
    });
    await writeFile(path.join(repo.dir, ".factory", "config.yaml"), "version: 2\n");
    await git(repo.dir, ["commit", "-qam", "broken config"]);
    expect((await checkProject(FAKE_PROJECT, deps)).at(-1)).toMatchObject({
      name: "config",
      ok: false,
    });
  });
});
