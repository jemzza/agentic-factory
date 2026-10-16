import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractLastJsonObject, OpenCodeRuntime, parseOpenCodeOutput } from "./opencode.js";
import type { AgentRunInput } from "./types.js";

const FAKE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "fake-opencode.mjs",
);
const KEY = "sk-test-opencode-0123456789";

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "factory-opencode-test-"));
  process.env["OPENAI_API_KEY"] = KEY;
  process.env["GEMINI_API_KEY"] = "other-vendor-secret-xyz";
});
afterAll(async () => {
  delete process.env["OPENAI_API_KEY"];
  delete process.env["GEMINI_API_KEY"];
  await rm(tmp, { recursive: true, force: true });
});

const runtime = (mode: string) =>
  new OpenCodeRuntime({
    bin: process.execPath,
    binArgs: [FAKE, mode],
    keyEnv: ["OPENAI_API_KEY"],
    logDir: tmp,
  });

const input = (over: Partial<AgentRunInput> = {}): AgentRunInput => ({
  role: "reviewer",
  prompt: "review this",
  systemPrompt: "You are a reviewer.",
  cwd: tmp,
  allowedTools: ["Read", "Grep", "Glob"],
  timeoutMs: 10_000,
  model: "openai/gpt-x-2026",
  outputSchema: { type: "object" },
  ...over,
});

/** Input without a structured-output schema (free-text answer). */
const plain = (over: Partial<AgentRunInput> = {}): AgentRunInput => {
  const i = input(over);
  delete i.outputSchema;
  return i;
};

describe("extractLastJsonObject", () => {
  it("finds the last JSON object in prose or fences and ignores braces in strings", () => {
    expect(extractLastJsonObject('a {"x":1} b ```json\n{"y":"}{"}\n``` c')).toEqual({ y: "}{" });
    expect(extractLastJsonObject("no json {here")).toBeUndefined();
    expect(extractLastJsonObject('{"outer":{"inner":2}}')).toEqual({ outer: { inner: 2 } });
  });
});

describe("parseOpenCodeOutput", () => {
  it("reads the live step_finish shape (reasoning billed as output, cache as input)", () => {
    const live = JSON.stringify({
      type: "step_finish",
      part: {
        id: "p",
        reason: "stop",
        type: "step-finish",
        cost: 0.0065885,
        tokens: {
          total: 2087,
          input: 3,
          output: 156,
          reasoning: 27,
          cache: { write: 1901, read: 0 },
        },
      },
    });
    expect(parseOpenCodeOutput(live)).toMatchObject({
      costUsd: 0.0065885,
      tokens: { input: 1904, output: 183 },
    });
  });

  it("joins text parts and sums cost and tokens from step_finish", () => {
    const out = [
      JSON.stringify({ type: "text", part: { text: "one" } }),
      JSON.stringify({
        type: "step_finish",
        part: { cost: 0.01, tokens: { input: 10, output: 2 } },
      }),
      "not json",
      JSON.stringify({ type: "text", part: { text: "two" } }),
      JSON.stringify({
        type: "step_finish",
        part: { cost: 0.02, tokens: { input: 5, output: 1 } },
      }),
    ].join("\n");
    expect(parseOpenCodeOutput(out)).toMatchObject({
      text: "one\ntwo",
      costUsd: 0.03,
      tokens: { input: 15, output: 3 },
    });
  });
});

describe("OpenCodeRuntime (fake process)", () => {
  it("returns the structured verdict, cost and tokens", async () => {
    const res = await runtime("structured").run(input());
    expect(res).toMatchObject({ ok: true, costUsd: 0.0123, tokens: { input: 106, output: 20 } });
    expect(res.structured).toMatchObject({ verdict: "approve" });
  });

  it("reports unknown cost when step_finish has none", async () => {
    const res = await runtime("no-cost").run(input());
    expect(res.ok).toBe(true);
    expect(res.costUsd).toBeUndefined();
  });

  it("reports a parse error when the answer has no JSON", async () => {
    expect(await runtime("prose").run(input())).toMatchObject({
      ok: false,
      error: { kind: "parse" },
    });
  });

  it("reports a process error with the session error message", async () => {
    const res = await runtime("error").run(input());
    expect(res).toMatchObject({ ok: false, error: { kind: "process" } });
    expect(res.error?.message).toMatch(/APIError: invalid model/);
  });

  it("times out and kills the process tree", async () => {
    const res = await runtime("hang").run(input({ timeoutMs: 800 }));
    expect(res).toMatchObject({ ok: false, error: { kind: "timeout" } });
  });

  it("runs read-only with an explicit env: only its own key, no other secrets", async () => {
    const res = await runtime("env").run(plain());
    const seen = JSON.parse(res.output) as {
      env: string[];
      permission: string;
      args: string[];
      message: string;
    };
    expect(seen.env).toContain("OPENAI_API_KEY");
    expect(seen.env).not.toContain("GEMINI_API_KEY");
    expect(JSON.parse(seen.permission)).toMatchObject({
      "*": "deny",
      read: "allow",
      external_directory: "deny",
    });
    expect(seen.args).toEqual(
      expect.arrayContaining(["run", "--format", "json", "--pure", "-m", "openai/gpt-x-2026"]),
    );
    expect(seen.args).not.toContain("--auto");
    expect(seen.message).toContain("You are a reviewer.");
  });

  it("masks the provider key in output, logs and stderr", async () => {
    const logPath = path.join(tmp, "leak", "01-reviewer.jsonl");
    const res = await runtime("leak").run(plain({ logPath }));
    expect(res.output).not.toContain(KEY);
    for (const f of await readdir(path.dirname(logPath))) {
      expect(await readFile(path.join(path.dirname(logPath), f), "utf8")).not.toContain(KEY);
    }
  });

  it("refuses the developer role and write tools", async () => {
    await expect(runtime("structured").run(input({ role: "developer" }))).rejects.toThrow(
      /read-only/,
    );
    await expect(runtime("structured").run(input({ allowedTools: ["Edit"] }))).rejects.toThrow();
  });
});
