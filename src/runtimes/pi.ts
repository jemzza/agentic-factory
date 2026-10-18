import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { runCommand, type CommandResult } from "../process/run-command.js";
import { createRedactor } from "../store/redact.js";
import { extractLastJsonObject } from "./opencode.js";
import { errorTextIsProviderUnavailable, hostSuspendedMessage } from "./provider-errors.js";
import { BLOCK_PREFIX, PI_READ_ONLY_TOOLS, RESPONSE_SCHEMA_ENV } from "./pi-guard.js";
import { checkOllamaModel, writeOllamaProvider, type OllamaModelPin } from "./pi-ollama.js";
import { assertToolsAllowed } from "./tool-policy.js";
import type { AgentRunInput, AgentRunResult, AgentRuntime, PermissionDenial } from "./types.js";

/*
 * Pi headless adapter (@earendil-works/pi-coding-agent 1.0.2), read-only roles only.
 *
 *   pi --mode json -p --no-session --no-extensions -e <pi-guard.ts> --no-skills
 *      --no-prompt-templates --no-themes --no-context-files --no-approve
 *      --tools read,grep,find,ls --model <provider/model> --system-prompt <text>   (prompt on stdin)
 *
 * Verified from `pi --help` and docs/json.md of 1.0.2, and live against a fake OpenAI-compatible
 * server on 127.0.0.1 (2026-10-18, no real provider):
 * - stdout is JSONL: a {"type":"session",...} header, then session events. Each assistant
 *   `message_end.message` has `stopReason` (stop | toolUse | length | error | aborted | ...),
 *   `errorMessage`, `provider`, `model` and `usage` {input, output, cacheRead, cacheWrite,
 *   totalTokens, cost: {total, ...}} in USD (per message, not cumulative).
 * - A provider error (HTTP 429 seen live: errorMessage "429: {...}") is retried 3 times
 *   (`auto_retry_start`), then `auto_retry_end` {success:false, finalError}; the process still
 *   EXITS 0. So the outcome is read from the events, never from the exit code alone.
 * - Blocked tool calls come back as `tool_execution_end` {isError:true} with the guard's
 *   reason; tools outside `--tools` answer "Tool <name> not found".
 * - With `-p` the prompt is read from stdin when stdin is a pipe.
 * - Pi has no schema flag: the structured answer is the last JSON object of the final text (as
 *   for OpenCode), validated by the caller with Zod. On a local Ollama model the factory's
 *   extension adds `response_format: json_schema` to every request (constrained decoding) and
 *   Pi runs with `--no-tools`; an invalid answer still gets the reviewers' one retry.
 * - No spend cap flag: the step timeout bounds a run; a cost above `maxBudgetUsd` is reported
 *   as a budget error after the fact.
 * Isolation: an explicit env (no inherited secrets), a factory-owned agent dir
 * (PI_CODING_AGENT_DIR: models.json for custom endpoints, auth.json if the owner signed in
 * to a subscription there) and HOME inside it; no sessions, extensions, skills, context files
 * or project trust; PI_OFFLINE=1, PI_TELEMETRY=0.
 */

const BASE_ENV = ["PATH", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL"];

/** Builds the child env explicitly: base vars, isolation, the role's provider keys. */
export function piEnv(
  agentDir: string,
  keyEnv: readonly string[],
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {
    HOME: path.join(agentDir, "home"),
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    NO_COLOR: "1",
  };
  for (const key of [...BASE_ENV, ...keyEnv]) {
    const v = source[key];
    if (v !== undefined) env[key] = v;
  }
  return env;
}

const UsageSchema = z.looseObject({
  input: z.number().optional(),
  output: z.number().optional(),
  cacheRead: z.number().optional(),
  cacheWrite: z.number().optional(),
  cost: z.looseObject({ total: z.number().optional() }).optional(),
});
const ContentSchema = z.array(z.looseObject({ type: z.string(), text: z.string().optional() }));
const AssistantEndSchema = z.looseObject({
  type: z.literal("message_end"),
  message: z.looseObject({
    role: z.literal("assistant"),
    content: ContentSchema.optional(),
    stopReason: z.string().optional(),
    errorMessage: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    responseModel: z.string().optional(),
    usage: UsageSchema.optional(),
  }),
});
const ToolEndSchema = z.looseObject({
  type: z.literal("tool_execution_end"),
  toolName: z.string(),
  isError: z.boolean().optional(),
  result: z.looseObject({ content: ContentSchema.optional() }).optional(),
});
const RetryEndSchema = z.looseObject({
  type: z.literal("auto_retry_end"),
  success: z.boolean(),
  finalError: z.string().optional(),
});
const EventSchema = z.looseObject({ type: z.string() });

export interface ParsedPiOutput {
  /** Text of the last assistant message that ended normally. */
  text: string;
  costUsd?: number;
  tokens?: { input: number; output: number };
  numTurns: number;
  modelsUsed: string[];
  denials: PermissionDenial[];
  /** The run's final error (last assistant message ended in error/abort, or retries gave up). */
  error: string | null;
  /** Provider retries started (a run of only retries means the provider never answered). */
  retries: number;
  /** Assistant messages that did not end in an error. */
  answers: number;
  events: number;
}

const textOf = (c: z.infer<typeof ContentSchema> | undefined) =>
  (c ?? [])
    .filter((p) => p.type === "text" && p.text !== undefined)
    .map((p) => p.text)
    .join("\n");

export function parsePiOutput(stdout: string): ParsedPiOutput {
  let text = "";
  let cost: number | undefined;
  let input: number | undefined;
  let output: number | undefined;
  let numTurns = 0;
  let retries = 0;
  let answers = 0;
  let events = 0;
  let error: string | null = null;
  const models = new Set<string>();
  const denials: PermissionDenial[] = [];
  // Split on LF only (docs/json.md: U+2028/2029 may appear inside JSON strings).
  for (const line of stdout.split("\n")) {
    const t = line.replace(/\r$/, "").trim();
    if (!t.startsWith("{")) continue;
    let json: unknown;
    try {
      json = JSON.parse(t);
    } catch {
      continue;
    }
    const ev = EventSchema.safeParse(json);
    if (!ev.success) continue;
    events++;
    if (ev.data.type === "auto_retry_start") retries++;
    const msg = AssistantEndSchema.safeParse(json);
    if (msg.success) {
      const m = msg.data.message;
      numTurns++;
      const u = m.usage;
      if (u?.cost?.total !== undefined) cost = (cost ?? 0) + u.cost.total;
      if (u?.input !== undefined || u?.cacheRead !== undefined || u?.cacheWrite !== undefined)
        input = (input ?? 0) + (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
      if (u?.output !== undefined) output = (output ?? 0) + u.output;
      const model = m.responseModel ?? m.model;
      if (model) models.add(m.provider ? `${m.provider}/${model}` : model);
      if (m.stopReason === "error" || m.stopReason === "aborted") {
        error = m.errorMessage ?? `assistant message ended with ${m.stopReason}`;
      } else if (m.stopReason === "length") {
        error = "the model's answer was cut off (stopReason length)";
      } else {
        answers++;
        error = null; // a later answer supersedes a retried error
        if (m.stopReason !== "toolUse") text = textOf(m.content);
      }
    }
    const tool = ToolEndSchema.safeParse(json);
    if (tool.success && tool.data.isError) {
      const why = textOf(tool.data.result?.content);
      if (why.startsWith(BLOCK_PREFIX) || /^Tool \S+ not found/.test(why))
        denials.push({ tool: tool.data.toolName, input: why });
    }
    const retryEnd = RetryEndSchema.safeParse(json);
    if (retryEnd.success && !retryEnd.data.success)
      error = retryEnd.data.finalError ?? "provider retries exhausted";
  }
  return {
    text: text.trim(),
    ...(cost !== undefined ? { costUsd: cost } : {}),
    ...(input !== undefined || output !== undefined
      ? { tokens: { input: input ?? 0, output: output ?? 0 } }
      : {}),
    numTurns,
    modelsUsed: [...models],
    denials,
    error,
    retries,
    answers,
    events,
  };
}

export interface PiRuntimeOptions {
  /** Executable; default PI_BIN or the project's node_modules/.bin/pi. */
  bin: string;
  binArgs?: string[];
  /** The factory's guard extension (src/runtimes/pi-guard.ts). */
  guardPath: string;
  /** Factory-owned Pi agent dir (outside the repository and every worktree). */
  agentDir: string;
  /** Env var names with this runtime's provider keys (passed to Pi only, masked in logs). */
  keyEnv: readonly string[];
  logDir: string;
  /**
   * A local Ollama model (pi-ollama.ts): checked before each run, written into the agent dir's
   * models.json, and asked for structured output (JSON Schema, no tools).
   */
  ollama?: OllamaModelPin;
}

export class PiRuntime implements AgentRuntime {
  readonly name = "pi";
  private seq = 0;
  constructor(private readonly options: PiRuntimeOptions) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    if (input.role === "developer")
      throw new Error("PiRuntime is read-only; it cannot run the developer");
    assertToolsAllowed(input.role, input.allowedTools);
    if (!input.model) throw new Error("PiRuntime needs an explicit provider/model");
    const { ollama } = this.options;
    if (ollama && input.model !== `ollama/${ollama.model}`)
      throw new Error(`PiRuntime: model ${input.model} is not the pinned ollama/${ollama.model}`);
    // Structured output only where the endpoint supports it (Ollama's /v1 response_format).
    const structured = ollama !== undefined && input.outputSchema !== undefined;

    const systemPrompt = [
      input.systemPrompt ?? "",
      input.outputSchema
        ? "## Answer format\n\nEnd with ONLY one JSON object matching this JSON Schema (no prose after it, no code fences):\n" +
          JSON.stringify(input.outputSchema)
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const args = [
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--no-extensions",
      "-e",
      this.options.guardPath,
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-approve",
      ...(structured ? ["--no-tools"] : ["--tools", PI_READ_ONLY_TOOLS.join(",")]),
      "--model",
      input.model,
      ...(systemPrompt ? ["--system-prompt", systemPrompt] : []),
    ];

    await mkdir(path.join(this.options.agentDir, "home"), { recursive: true });
    const env = piEnv(this.options.agentDir, this.options.keyEnv);
    if (structured) env[RESPONSE_SCHEMA_ENV] = JSON.stringify(input.outputSchema);
    const redact = createRedactor(this.options.keyEnv.map((k) => env[k]));
    const logPath =
      input.logPath ??
      path.join(this.options.logDir, `${String(++this.seq).padStart(2, "0")}-${input.role}.jsonl`);
    await mkdir(path.dirname(logPath), { recursive: true });
    await writeFile(
      `${logPath}.input.json`,
      redact(
        JSON.stringify(
          { bin: this.options.bin, args, cwd: input.cwd, prompt: input.prompt },
          null,
          2,
        ),
      ),
    );

    if (ollama) {
      const started = Date.now();
      const check = await checkOllamaModel(ollama);
      if (!check.ok) {
        await writeFile(logPath, `${JSON.stringify({ type: "factory_ollama_check", ...check })}\n`);
        return {
          ok: false,
          output: "",
          durationMs: Date.now() - started,
          rawLogPath: logPath,
          permissionDenials: [],
          error: { kind: check.kind, message: check.message },
        };
      }
      await writeOllamaProvider(this.options.agentDir, ollama);
    }

    const proc = await runCommand(this.options.bin, [...(this.options.binArgs ?? []), ...args], {
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      env,
      input: input.prompt,
      killTree: true,
    });
    await writeFile(logPath, redact(proc.stdout));
    if (proc.stderr) await writeFile(`${logPath}.stderr`, redact(proc.stderr));
    return interpretPiRun(proc, input, logPath, redact);
  }
}

export function interpretPiRun(
  proc: CommandResult,
  input: Pick<AgentRunInput, "outputSchema" | "timeoutMs" | "maxBudgetUsd">,
  rawLogPath: string,
  redact: (s: string) => string = (s) => s,
): AgentRunResult {
  const parsed = parsePiOutput(proc.stdout);
  const base = {
    durationMs: proc.durationMs,
    rawLogPath,
    permissionDenials: parsed.denials,
    output: redact(parsed.text),
    numTurns: parsed.numTurns,
    ...(parsed.modelsUsed.length ? { modelsUsed: parsed.modelsUsed } : {}),
    ...(parsed.costUsd !== undefined ? { costUsd: parsed.costUsd } : {}),
    ...(parsed.tokens ? { tokens: parsed.tokens } : {}),
  };
  const fail = (
    kind: "timeout" | "process" | "parse" | "infra" | "budget",
    message: string,
  ): AgentRunResult => ({ ...base, ok: false, error: { kind, message: redact(message) } });

  const suspended = hostSuspendedMessage(proc);
  if (suspended && (proc.timedOut || proc.exitCode !== 0 || parsed.error !== null))
    return fail("infra", suspended);
  if (proc.timedOut) {
    // Only retries, no answer: the provider never answered within the step.
    if (parsed.retries > 0 && parsed.answers === 0)
      return fail("infra", `provider unavailable: retried ${String(parsed.retries)} time(s)`);
    return fail("timeout", `agent did not finish within ${String(input.timeoutMs)} ms`);
  }
  if (proc.spawnError !== undefined)
    return fail("process", `failed to start pi: ${proc.spawnError}`);
  if (parsed.error !== null) {
    return errorTextIsProviderUnavailable(parsed.error)
      ? fail("infra", `provider unavailable: ${parsed.error}`)
      : fail("process", `pi: ${parsed.error}`);
  }
  if (proc.exitCode !== 0) {
    const why = proc.stderr.trim().split("\n").slice(-5).join("\n");
    return errorTextIsProviderUnavailable(why)
      ? fail("infra", `provider unavailable: ${why}`)
      : fail("process", `pi exited with code ${String(proc.exitCode ?? "null")}: ${why}`);
  }
  if (parsed.events === 0) return fail("parse", "pi produced no JSON events");
  if (
    input.maxBudgetUsd !== undefined &&
    parsed.costUsd !== undefined &&
    parsed.costUsd > input.maxBudgetUsd
  ) {
    return fail(
      "budget",
      `spent $${parsed.costUsd.toFixed(4)} of a $${input.maxBudgetUsd.toFixed(4)} budget`,
    );
  }
  if (input.outputSchema !== undefined) {
    const structured = extractLastJsonObject(parsed.text);
    if (structured === undefined)
      return fail("parse", "no JSON object found in the agent's answer");
    return { ...base, ok: true, structured };
  }
  return { ...base, ok: true };
}
