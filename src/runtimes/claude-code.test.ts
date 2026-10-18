import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentEnv,
  buildClaudeArgs,
  ClaudeCodeRuntime,
  isProviderUnavailable,
  parseStreamJson,
} from "./claude-code.js";
import { developerTools, READ_ONLY_TOOLS } from "./tool-policy.js";
import type { AgentRunInput } from "./types.js";

const FAKE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "fake-claude.mjs",
);

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "factory-runtime-test-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function runtime(mode: string): ClaudeCodeRuntime {
  return new ClaudeCodeRuntime({ bin: process.execPath, binArgs: [FAKE, mode], logDir: tmp });
}

function input(overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    role: "planner",
    prompt: "plan it",
    cwd: tmp,
    allowedTools: [...READ_ONLY_TOOLS],
    timeoutMs: 10_000,
    ...overrides,
  };
}

/** Value(s) following a flag up to the next `--flag`. */
function flag(argv: string[], name: string): string[] {
  const i = argv.indexOf(name);
  if (i === -1) return [];
  const rest = argv.slice(i + 1);
  const end = rest.findIndex((a) => a.startsWith("--"));
  return end === -1 ? rest : rest.slice(0, end);
}

describe("buildClaudeArgs", () => {
  it("runs read-only roles in dontAsk mode with only read tools and no allow rules", () => {
    for (const role of ["planner", "reviewer"] as const) {
      const argv = buildClaudeArgs(input({ role }), "opus");
      expect(flag(argv, "--tools")).toEqual(["Read,Grep,Glob"]);
      expect(flag(argv, "--permission-mode")).toEqual(["dontAsk"]);
      expect(argv).not.toContain("--allowedTools");
    }
  });

  it("runs the developer in acceptEdits mode with exact Bash allow rules only", () => {
    const argv = buildClaudeArgs(
      input({ role: "developer", allowedTools: developerTools(["npm run check", "npm test"]) }),
      "opus",
    );
    expect(flag(argv, "--tools")).toEqual(["Read,Grep,Glob,Edit,Write,Bash"]);
    expect(flag(argv, "--permission-mode")).toEqual(["acceptEdits"]);
    const allow = flag(argv, "--allowedTools");
    expect(allow).toContain("Bash(npm run check)");
    // Bare file-tool allow rules would permit access outside the worktree.
    expect(allow.every((r) => r.startsWith("Bash("))).toBe(true);
  });

  it("always isolates from host settings and denies prompts", () => {
    const argv = buildClaudeArgs(input(), "opus");
    expect(argv.slice(0, 4)).toEqual(["-p", "--output-format", "stream-json", "--verbose"]);
    expect(flag(argv, "--permission-prompts")).toEqual(["none"]);
    expect(flag(argv, "--setting-sources")).toEqual([""]);
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).toContain("--no-session-persistence");
    expect(argv).not.toContain("--dangerously-skip-permissions");
    expect(argv.join(" ")).not.toMatch(/bypassPermissions/);
  });

  it("denies secret files for every role", () => {
    const deny = flag(buildClaudeArgs(input(), "opus"), "--disallowedTools");
    expect(deny).toContain("Read(./.env*)");
    expect(deny).toContain("Edit(./**/.env*)");
  });

  it("passes system prompt, schema, budget and model", () => {
    const argv = buildClaudeArgs(
      input({ systemPrompt: "rules", outputSchema: { type: "object" }, maxBudgetUsd: 0.5 }),
      "sonnet",
    );
    expect(flag(argv, "--append-system-prompt")).toEqual(["rules"]);
    expect(flag(argv, "--json-schema")).toEqual(['{"type":"object"}']);
    expect(flag(argv, "--max-budget-usd")).toEqual(["0.5"]);
    expect(flag(argv, "--model")).toEqual(["sonnet"]);
  });

  it.each([
    ["planner", ["Read", "Edit"]],
    ["reviewer", ["Bash(npm test)"]],
    ["planner", ["Read(./src/**)"]],
    ["developer", ["Read", "Bash"]],
    ["developer", ["Bash(git diff *)"]],
    ["developer", ["WebFetch"]],
    ["developer", []],
  ] as const)("rejects %s with tools %j", (role, allowedTools) => {
    expect(() =>
      buildClaudeArgs(input({ role, allowedTools: [...allowedTools] }), "opus"),
    ).toThrow();
  });
});

describe("parseStreamJson", () => {
  it("finds the result event even when it is not the last line", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }),
      JSON.stringify({ type: "system", subtype: "task_summary" }),
    ].join("\n");
    expect(parseStreamJson(stdout)).toMatchObject({ kind: "result", event: { result: "ok" } });
  });

  it("reports missing and malformed result events", () => {
    expect(parseStreamJson("not json\n")).toEqual({ kind: "missing" });
    expect(parseStreamJson(JSON.stringify({ type: "result" }))).toMatchObject({ kind: "invalid" });
  });
});

describe("live result events (Claude Code 2.1.300)", () => {
  it("parses real success and usage-limit results unchanged and classifies them", async () => {
    const live = JSON.parse(
      await readFile(path.join(path.dirname(FAKE), "live-result-events-2.1.300.json"), "utf8"),
    ) as { success: unknown; usage_limit: unknown };
    const ok = parseStreamJson(JSON.stringify(live.success));
    const limited = parseStreamJson(JSON.stringify(live.usage_limit));
    expect(ok.kind).toBe("result");
    expect(limited.kind).toBe("result");
    if (ok.kind !== "result" || limited.kind !== "result") return;
    expect(ok.event.api_error_status).toBeNull();
    expect(Object.keys(ok.event.modelUsage ?? {})).toEqual(["claude-opus-5-5"]);
    expect(isProviderUnavailable(ok.event)).toBe(false);
    expect(isProviderUnavailable(limited.event)).toBe(true);
  });
});

describe("agentEnv", () => {
  it("passes only allow-listed variables", () => {
    const env = agentEnv({
      HOME: "/h",
      PATH: "/bin",
      GITHUB_TOKEN: "x",
      AWS_SECRET_ACCESS_KEY: "y",
    });
    expect(env["HOME"]).toBe("/h");
    expect(env["PATH"]).toBe("/bin");
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    // Provider keys of other runtimes (e.g. the OpenCode reviewer) never reach Claude Code.
    expect(agentEnv({ HOME: "/h", OPENAI_API_KEY: "k1", GEMINI_API_KEY: "k2" })).not.toHaveProperty(
      "OPENAI_API_KEY",
    );
    expect(agentEnv({ HOME: "/h", GEMINI_API_KEY: "k2" })).not.toHaveProperty("GEMINI_API_KEY");
    expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
  });
});

describe("ClaudeCodeRuntime (fake process)", () => {
  it("returns output, cost, tokens and turns on success and saves the raw log", async () => {
    const res = await runtime("success").run(input());
    expect(res).toMatchObject({
      ok: true,
      output: "done",
      costUsd: 0.0123,
      tokens: { input: 115, output: 20 },
      numTurns: 3,
      permissionDenials: [],
    });
    // The model that actually answered, as the CLI reports it (fake: "resolved-<--model>").
    expect(res.modelsUsed).toEqual([`resolved-${input().model ?? "opus"}`]);
    expect(res.error).toBeUndefined();
    expect(await readFile(res.rawLogPath, "utf8")).toContain('"type":"result"');
    expect(await readFile(`${res.rawLogPath}.input.json`, "utf8")).toContain("plan it");
  });

  it("sends the prompt on stdin and does not leak host env vars", async () => {
    process.env["FACTORY_FAKE_SECRET"] = "s3cret";
    try {
      const res = await runtime("echo").run(input({ prompt: "hello agent" }));
      const echoed = JSON.parse(res.output) as { stdin: string; env: string[] };
      expect(echoed.stdin).toBe("hello agent");
      expect(echoed.env).not.toContain("FACTORY_FAKE_SECRET");
    } finally {
      delete process.env["FACTORY_FAKE_SECRET"];
    }
  });

  it("returns structured output when a schema is requested", async () => {
    const res = await runtime("structured").run(input({ outputSchema: { type: "object" } }));
    expect(res).toMatchObject({ ok: true, structured: { plan: "x" } });
  });

  it("reports a parse error when structured output is missing", async () => {
    const res = await runtime("structured-missing").run(
      input({ outputSchema: { type: "object" } }),
    );
    expect(res.ok).toBe(false);
    expect(res.error?.kind).toBe("parse");
    expect(res.costUsd).toBe(0.0123); // cost is still accounted
  });

  it("reports a parse error for invalid JSON output", async () => {
    const res = await runtime("garbage").run(input());
    expect(res).toMatchObject({ ok: false, error: { kind: "parse" } });
  });

  it("reports a parse error for a malformed result event", async () => {
    const res = await runtime("malformed-result").run(input());
    expect(res).toMatchObject({ ok: false, error: { kind: "parse" } });
  });

  it("reports a process error with stderr on a non-zero exit", async () => {
    const res = await runtime("crash").run(input());
    expect(res.ok).toBe(false);
    expect(res.error?.kind).toBe("process");
    expect(res.error?.message).toMatch(/code 3.*something exploded/s);
    expect(await readFile(`${res.rawLogPath}.stderr`, "utf8")).toContain("exploded");
  });

  it("reports an error result from the agent as a process error", async () => {
    const res = await runtime("error-result").run(input());
    expect(res).toMatchObject({ ok: false, error: { kind: "process" } });
    expect(res.error?.message).toMatch(/API overloaded/);
  });

  it("reports a provider usage limit as infra (from the structured API error fields)", async () => {
    const res = await runtime("usage-limit").run(input());
    expect(res).toMatchObject({ ok: false, error: { kind: "infra" } });
    expect(res.error?.message).toMatch(/usage_limit_reached.*session limit/);
  });

  it("reports an unreachable API (no result event, network errno) as infra", async () => {
    const res = await runtime("network-down").run(input());
    expect(res).toMatchObject({ ok: false, error: { kind: "infra" } });
    expect(res.error?.message).toMatch(/ECONNREFUSED/);
  });

  it("keeps a bad request built by the factory a process error, not infra", async () => {
    const res = await runtime("bad-request").run(input());
    expect(res).toMatchObject({ ok: false, error: { kind: "process" } });
  });

  it("does not trust a success result with a non-zero exit code", async () => {
    const res = await runtime("success-nonzero").run(input());
    expect(res).toMatchObject({ ok: false, error: { kind: "process" } });
  });

  it("reports budget exhaustion with the actual cost", async () => {
    const res = await runtime("budget").run(input({ maxBudgetUsd: 0.01 }));
    expect(res).toMatchObject({ ok: false, costUsd: 0.05, error: { kind: "budget" } });
  });

  it("reports permission denials", async () => {
    const res = await runtime("denied").run(input());
    expect(res.permissionDenials).toEqual([{ tool: "Bash", input: { command: "curl x" } }]);
  });

  it("times out, kills the agent and its children, and reports timeout", async () => {
    const res = await runtime("hang").run(input({ timeoutMs: 1_000 }));
    expect(res).toMatchObject({ ok: false, error: { kind: "timeout" } });
    expect(res.durationMs).toBeLessThan(8_000);
    const log = await readFile(res.rawLogPath, "utf8");
    const pid = (JSON.parse(log.split("\n")[1] ?? "{}") as { pid?: number }).pid;
    if (pid === undefined) throw new Error("fake agent did not report its child pid");
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("reports a timeout with only api_retry events (API never answered) as infra", async () => {
    const res = await runtime("api-retry-hang").run(input({ timeoutMs: 1_000 }));
    expect(res).toMatchObject({ ok: false, error: { kind: "infra" } });
    expect(res.error?.message).toMatch(/api_retry/);
  });

  it("keeps a timeout after real model output a timeout, even after a retry", async () => {
    const res = await runtime("work-then-hang").run(input({ timeoutMs: 1_000 }));
    expect(res).toMatchObject({ ok: false, error: { kind: "timeout" } });
  });

  it("reports a missing binary as a process error", async () => {
    const rt = new ClaudeCodeRuntime({ bin: "/nonexistent/claude", logDir: tmp });
    const res = await rt.run(input());
    expect(res).toMatchObject({ ok: false, error: { kind: "process" } });
  });

  it("throws (factory bug) when the tool policy is violated", async () => {
    await expect(
      runtime("success").run(input({ role: "reviewer", allowedTools: ["Edit"] })),
    ).rejects.toThrow(/read-only/);
  });
});
