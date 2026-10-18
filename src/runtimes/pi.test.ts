import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REVIEWER_OUTPUT_SCHEMA, reviewWithRetry } from "../agents/reviewer.js";
import { FAKE_APPROVE, FAKE_TASK } from "../testing/fakes.js";
import { PI_BIN, PI_GUARD } from "./registry.js";
import { guardToolCall } from "./pi-guard.js";
import { parsePiOutput, piEnv, PiRuntime } from "./pi.js";
import type { AgentRunInput } from "./types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, "__fixtures__", "fake-pi.mjs");
const fixture = (name: string) => readFile(path.join(HERE, "__fixtures__", name), "utf8");
const KEY = "gemini-test-key-0123456789abcdef";

let tmp: string;
let wt: string;
beforeAll(async () => {
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "factory-pi-test-")));
  wt = path.join(tmp, "wt");
  await mkdir(path.join(wt, "src"), { recursive: true });
  await writeFile(path.join(wt, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(path.join(wt, ".env"), "SECRET=1\n");
  await writeFile(path.join(tmp, "outside.txt"), "outside\n");
  await symlink(path.join(tmp, "outside.txt"), path.join(wt, "src", "link.txt"));
  process.env["GEMINI_API_KEY"] = KEY;
  process.env["OTHER_SECRET"] = "must-not-reach-pi";
});
afterAll(async () => {
  delete process.env["GEMINI_API_KEY"];
  delete process.env["OTHER_SECRET"];
  await rm(tmp, { recursive: true, force: true });
});

const runtime = (mode: string) =>
  new PiRuntime({
    bin: process.execPath,
    binArgs: [FAKE, mode],
    guardPath: PI_GUARD,
    agentDir: path.join(tmp, "agent"),
    keyEnv: ["GEMINI_API_KEY"],
    logDir: path.join(tmp, "logs"),
  });

const input = (over: Partial<AgentRunInput> = {}): AgentRunInput => ({
  role: "reviewer",
  prompt: "review this diff",
  systemPrompt: "You are a reviewer.",
  cwd: wt,
  allowedTools: ["Read", "Grep", "Glob"],
  timeoutMs: 10_000,
  model: "google/gemini-x",
  outputSchema: { type: "object" },
  ...over,
});

describe("pi-guard (the boundary for Pi's tools)", () => {
  it.each([
    ["read", { path: "src/a.ts" }],
    ["read", { path: "@src/a.ts" }],
    ["read", { path: "src/../src/a.ts" }],
    ["grep", { pattern: "x", glob: "src/**/*.ts" }],
    ["find", { pattern: "**/*.ts" }],
    ["ls", {}],
  ])("allows %s %j inside the worktree", (tool, args) => {
    expect(guardToolCall(wt, tool, args)).toBeNull();
  });

  it.each([
    ["read", { path: "/etc/hosts" }, /outside/],
    ["read", { path: "../outside.txt" }, /outside/],
    ["read", { path: "~/.ssh/id_rsa" }, /outside/],
    ["read", { path: "src/link.txt" }, /outside/], // symlink to a file outside
    ["read", { path: ".env" }, /secret/],
    ["read", { path: "config/server.pem" }, /secret/],
    ["read", {}, /needs a path/],
    ["grep", { pattern: "KEY", glob: ".env*" }, /secret/],
    ["grep", { pattern: "x", path: "/" }, /outside/],
    ["find", { pattern: "../**" }, /outside/],
    ["find", { pattern: "/etc/*" }, /outside/],
    ["bash", { command: "cat .env" }, /not allowed/],
    ["write", { path: "src/a.ts", content: "" }, /not allowed/],
    ["edit", { path: "src/a.ts" }, /not allowed/],
  ])("blocks %s %j", (tool, args, why) => {
    expect(guardToolCall(wt, tool, args)).toMatch(why);
  });
});

describe("parsePiOutput (recorded Pi 1.0.2 streams)", () => {
  it("reads a guarded review: blocked calls, per-message cost and tokens, the final text", async () => {
    const p = parsePiOutput(await fixture("live-guarded-review-1.0.2.jsonl"));
    expect(p.error).toBeNull();
    expect(p.text).toContain('{"verdict":"approve"');
    expect(p.numTurns).toBe(5);
    expect(p.costUsd).toBeCloseTo(5 * 0.00012, 8);
    expect(p.tokens).toEqual({ input: 500, output: 50 });
    expect(p.modelsUsed).toEqual(["fake/fake-1"]);
    expect(p.denials.map((d) => d.tool)).toEqual(["read", "read", "bash"]);
    expect(String(p.denials[0]?.input)).toMatch(/^factory-guard: "\/etc\/hosts" is outside/);
  });

  it("reads exhausted 429 retries as the run's error although Pi exits 0", async () => {
    const p = parsePiOutput(await fixture("live-429-retries-1.0.2.jsonl"));
    expect(p.error).toMatch(/^429: /);
    expect(p.retries).toBe(3);
    expect(p.answers).toBe(0);
  });
});

describe("PiRuntime on a fake pi process", () => {
  it("passes isolation flags, the prompt on stdin, and only the role's key", async () => {
    const plain = input();
    delete plain.outputSchema;
    const r = await runtime("echo").run(plain);
    expect(r.ok).toBe(true);
    const report = JSON.parse(r.output.slice("report ".length)) as {
      args: string[];
      env: Record<string, string>;
      stdin: string;
      cwd: string;
    };
    expect(report.stdin).toBe("review this diff");
    expect(report.cwd).toBe(wt);
    for (const flag of [
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "--no-approve",
    ])
      expect(report.args).toContain(flag);
    expect(report.args.join(" ")).toContain("--tools read,grep,find,ls");
    expect(report.args.join(" ")).toContain(`-e ${PI_GUARD}`);
    expect(report.args.join(" ")).toContain("--model google/gemini-x");
    expect(report.env["PI_CODING_AGENT_DIR"]).toBe(path.join(tmp, "agent"));
    expect(report.env["HOME"]).toBe(path.join(tmp, "agent", "home"));
    expect(report.env).toMatchObject({ PI_OFFLINE: "1", PI_TELEMETRY: "0" });
    expect(report.env["OTHER_SECRET"]).toBeUndefined();
    // The key reached Pi but is masked in everything the factory keeps.
    expect(r.output).not.toContain(KEY);
    const log = await readFile(r.rawLogPath, "utf8");
    expect(log).not.toContain(KEY);
    expect(log).toContain("***");
  });

  it("returns the structured answer, cost, tokens and denials of a recorded run", async () => {
    const r = await runtime("replay-ok").run(input());
    expect(r).toMatchObject({
      ok: true,
      structured: { verdict: "approve" },
      tokens: { input: 500, output: 50 },
      modelsUsed: ["fake/fake-1"],
    });
    expect(r.permissionDenials).toHaveLength(3);
  });

  it("classifies provider refusals as infra_error (429 after retries, exit 0)", async () => {
    const r = await runtime("replay-429").run(input());
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ kind: "infra" });
    expect(r.error?.message).toMatch(/429/);
  });

  it("a recovered retry is a normal answer; a 4xx request error is a process error", async () => {
    expect(await runtime("retry-then-ok").run(input())).toMatchObject({ ok: true });
    expect((await runtime("bad-request").run(input())).error).toMatchObject({ kind: "process" });
  });

  it("times out (and, when only retries happened, reports the provider)", async () => {
    const t = await runtime("hang").run(input({ timeoutMs: 1_500 }));
    expect(t.error?.kind).toBe("timeout");
    const i = await runtime("retry-hang").run(input({ timeoutMs: 1_500 }));
    expect(i.error?.kind).toBe("infra");
  }, 20_000);

  it("reports a crash, garbage, a missing JSON answer, a cut-off answer and an overspend", async () => {
    expect((await runtime("crash").run(input())).error).toMatchObject({
      kind: "process",
      message: expect.stringContaining("not found") as unknown,
    });
    expect((await runtime("garbage").run(input())).error?.kind).toBe("parse");
    expect((await runtime("nojson").run(input())).error?.kind).toBe("parse");
    expect((await runtime("length").run(input())).error?.kind).toBe("process");
    expect((await runtime("budget").run(input({ maxBudgetUsd: 1 }))).error?.kind).toBe("budget");
  });

  it("refuses the developer role and tools beyond read-only", async () => {
    await expect(runtime("echo").run(input({ role: "developer" }))).rejects.toThrow(/read-only/);
    await expect(runtime("echo").run(input({ allowedTools: ["Read", "Edit"] }))).rejects.toThrow(
      /read-only tools/,
    );
  });

  it("builds the env from an allowlist", () => {
    const env = piEnv("/a", ["GEMINI_API_KEY"], {
      PATH: "/bin",
      GEMINI_API_KEY: "k",
      AWS_SECRET_ACCESS_KEY: "s",
    });
    expect(env).toEqual({
      PATH: "/bin",
      GEMINI_API_KEY: "k",
      HOME: "/a/home",
      PI_CODING_AGENT_DIR: "/a",
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      NO_COLOR: "1",
    });
  });
});

/*
 * The real Pi binary (node_modules) against a fake OpenAI-compatible provider on 127.0.0.1: no
 * network, $0. The fake model asks for a file outside the worktree, the .env, bash, and a file
 * inside; only the last may run. Proves the flags and the guard with Pi itself.
 */
describe("PiRuntime with the real pi binary (fake provider on 127.0.0.1)", () => {
  const steps = [
    { tool: "read", args: { path: "/etc/hosts" } },
    { tool: "read", args: { path: ".env" } },
    { tool: "bash", args: { command: "cat .env" } },
    { tool: "read", args: { path: "src/link.txt" } },
    { tool: "read", args: { path: "src/a.ts" } },
    { text: 'Reviewed.\n{"verdict":"approve","issues":[],"criteria_check":[]}' },
  ];
  let server: http.Server;
  const bodies: string[] = [];

  beforeAll(async () => {
    let n = 0;
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        bodies.push(body);
        const step = steps[Math.min(n++, steps.length - 1)];
        const chunk = (delta: unknown, finish: string | null) =>
          `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "fake-1", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (step && "tool" in step) {
          res.write(
            chunk(
              {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${String(n)}`,
                    type: "function",
                    function: { name: step.tool, arguments: JSON.stringify(step.args) },
                  },
                ],
              },
              null,
            ),
          );
          res.write(chunk({}, "tool_calls"));
        } else {
          res.write(chunk({ role: "assistant", content: step?.text ?? "" }, null));
          res.write(chunk({}, "stop"));
        }
        res.write(
          `data: ${JSON.stringify({ id: "u", object: "chat.completion.chunk", created: 1, model: "fake-1", choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const agentDir = path.join(tmp, "real-agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      path.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          fake: {
            baseUrl: `http://127.0.0.1:${String(port)}/v1`,
            api: "openai-completions",
            apiKey: "$GEMINI_API_KEY",
            models: [{ id: "fake-1", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
          },
        },
      }),
    );
  });
  afterAll(() => {
    server.close();
  });

  it("only the read inside the worktree runs; the answer, cost and denials come back", async () => {
    const pi = new PiRuntime({
      bin: PI_BIN,
      guardPath: PI_GUARD,
      agentDir: path.join(tmp, "real-agent"),
      keyEnv: ["GEMINI_API_KEY"],
      logDir: path.join(tmp, "real-logs"),
    });
    const r = await pi.run(input({ model: "fake/fake-1", timeoutMs: 60_000 }));
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ ok: true, structured: { verdict: "approve" }, numTurns: 6 });
    expect(r.costUsd).toBeGreaterThan(0);
    expect(r.permissionDenials.map((d) => [d.tool, String(d.input)])).toEqual([
      ["read", expect.stringMatching(/outside the working directory/) as unknown],
      ["read", expect.stringMatching(/secret file/) as unknown],
      ["bash", expect.stringMatching(/not found/) as unknown],
      ["read", expect.stringMatching(/outside the working directory/) as unknown],
    ]);
    const all = bodies.join("\n");
    expect(all).toContain("export const a = 1;"); // the allowed read reached the model
    expect(all).not.toContain("SECRET=1");
    expect(all).not.toContain("outside\\n");
    expect(all).not.toContain("localhost"); // /etc/hosts never read
  }, 90_000);
});

/*
 * Pi reviewer on a local model, end to end with the real Pi binary: a fake Ollama on 127.0.0.1
 * (/api/tags, /api/show, /v1/chat/completions). Checks the pre-run model check, the generated
 * models.json, structured output (response_format json_schema, no tools) and the reviewers'
 * single retry after an invalid answer.
 */
describe("PiRuntime on a local Ollama model (real pi binary, fake Ollama)", () => {
  const MODEL = "factory-reviewer-test";
  const answers = ["I think it looks good.", JSON.stringify(FAKE_APPROVE)];
  const chats: Record<string, unknown>[] = [];
  let server: http.Server;
  let url: string;

  beforeAll(async () => {
    let n = 0;
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        if (req.url === "/api/tags") {
          res.end(
            JSON.stringify({
              models: [
                { name: "base:7b-q4", digest: "abcdef123456" + "0".repeat(52) },
                { name: `${MODEL}:latest`, digest: "1".repeat(64) },
              ],
            }),
          );
          return;
        }
        if (req.url === "/api/show") {
          const derived = (JSON.parse(body) as { model: string }).model === MODEL;
          res.end(
            JSON.stringify({
              modelfile: "FROM /blobs/sha256-weights\n",
              parameters: derived ? "num_ctx 32768\ntemperature 0" : "",
            }),
          );
          return;
        }
        chats.push(JSON.parse(body) as Record<string, unknown>);
        const text = answers[Math.min(n++, answers.length - 1)] ?? "";
        const chunk = (delta: unknown, finish: string | null) =>
          `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(chunk({ role: "assistant", content: text }, null));
        res.write(chunk({}, "stop"));
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });
  afterAll(() => {
    server.close();
  });

  it("asks for JSON-schema output without tools, retries an invalid answer once, returns the verdict", async () => {
    const agentDir = path.join(tmp, "ollama-agent");
    const pi = new PiRuntime({
      bin: PI_BIN,
      guardPath: PI_GUARD,
      agentDir,
      keyEnv: [],
      logDir: path.join(tmp, "ollama-logs"),
      ollama: {
        url,
        baseModel: "base:7b-q4",
        digest: "abcdef123456",
        model: MODEL,
        numCtx: 32768,
        modelfile: "ollama/test.Modelfile",
      },
    });
    const { outcome, attempts } = await reviewWithRetry(
      (prompt) =>
        pi.run(
          input({
            prompt,
            model: `ollama/${MODEL}`,
            outputSchema: REVIEWER_OUTPUT_SCHEMA,
            timeoutMs: 60_000,
          }),
        ),
      "review this diff",
      FAKE_TASK,
    );
    expect(attempts).toBe(2);
    expect(outcome).toMatchObject({ ok: true, value: { verdict: "approve" } });
    expect(chats).toHaveLength(2);
    for (const c of chats) {
      expect(c["response_format"]).toMatchObject({
        type: "json_schema",
        json_schema: { schema: { properties: { verdict: {} } } },
      });
      expect(c["tools"] ?? []).toEqual([]);
    }
    const models = JSON.parse(await readFile(path.join(agentDir, "models.json"), "utf8")) as {
      providers: { ollama: { baseUrl: string } };
    };
    expect(models.providers.ollama.baseUrl).toBe(`${url}/v1`);
  }, 120_000);

  it("stops before Pi starts when the pinned model is missing (a process error with the fix)", async () => {
    const pi = new PiRuntime({
      bin: PI_BIN,
      guardPath: PI_GUARD,
      agentDir: path.join(tmp, "ollama-agent-2"),
      keyEnv: [],
      logDir: path.join(tmp, "ollama-logs-2"),
      ollama: {
        url,
        baseModel: "not-pulled:1b",
        digest: "abcdef123456",
        model: MODEL,
        numCtx: 32768,
        modelfile: "ollama/test.Modelfile",
      },
    });
    const before = chats.length;
    const r = await pi.run(input({ model: `ollama/${MODEL}` }));
    expect(r.error).toMatchObject({
      kind: "process",
      message: expect.stringContaining("ollama pull not-pulled:1b") as unknown,
    });
    expect(chats.length).toBe(before);
  });
});
