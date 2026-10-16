import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { runCommand, type CommandResult } from "../process/run-command.js";
import { createRedactor } from "../store/redact.js";
import { assertToolsAllowed } from "./tool-policy.js";
import type { AgentRunInput, AgentRunResult, AgentRuntime } from "./types.js";

/*
 * OpenCode headless adapter (opencode-ai 1.19.0), read-only roles only (planner, reviewer).
 *
 *   opencode run --format json --pure -m <provider/model> --dir <cwd> <message>
 *
 * Verified from `opencode run --help` and the 1.19.0 source of `cli/cmd/run.ts`:
 * - stdout is JSON Lines: {type, timestamp, sessionID, ...}; types "text" (part.text, emitted
 *   once the part is complete), "tool_use", "step_start", "step_finish" (the step part),
 *   "reasoning", "error" ({error}). There is no aggregate result: the final answer is the
 *   concatenation of the text parts.
 * - Exit code 1 on a session error, a failed prompt or a stream crash; 0 otherwise.
 * - In `run` mode permission requests are REJECTED unless --auto is given (never used here).
 *   On top of that OPENCODE_PERMISSION denies every tool except read/grep/glob/list.
 * - No system-prompt flag and no schema-constrained output: the role instructions are put at
 *   the top of the message, and a structured answer is the last JSON object in the text,
 *   validated by the caller with Zod.
 * NOT yet verified live (no provider key at implementation time): where `step_finish` carries
 * cost and tokens. Read defensively below; without them the cost is reported as unknown.
 */

const READ_ONLY_PERMISSION = {
  "*": "deny",
  read: "allow",
  grep: "allow",
  glob: "allow",
  list: "allow",
  external_directory: "deny",
};

/** Isolation from the user's setup: no project config, no ~/.claude, no plugins or sharing. */
const ISOLATION_ENV: Record<string, string> = {
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OPENCODE_DISABLE_CLAUDE_CODE: "1",
  OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1",
  OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_SHARE: "1",
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
  OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
  NO_COLOR: "1",
};

const BASE_ENV = ["HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "LANG", "LC_ALL"];

/** Builds the child env explicitly: base vars, isolation flags, permissions, the role's keys. */
export function opencodeEnv(
  keyEnv: readonly string[],
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {
    ...ISOLATION_ENV,
    OPENCODE_PERMISSION: JSON.stringify(READ_ONLY_PERMISSION),
  };
  for (const key of [...BASE_ENV, ...keyEnv]) {
    const v = source[key];
    if (v !== undefined) env[key] = v;
  }
  return env;
}

const EventSchema = z.looseObject({ type: z.string() });
const TextEventSchema = z.looseObject({
  type: z.literal("text"),
  part: z.looseObject({ text: z.string() }),
});
const StepFinishSchema = z.looseObject({
  type: z.literal("step_finish"),
  part: z.looseObject({
    cost: z.number().optional(),
    tokens: z
      .looseObject({
        input: z.number().optional(),
        output: z.number().optional(),
        cache: z
          .looseObject({ read: z.number().optional(), write: z.number().optional() })
          .optional(),
      })
      .optional(),
  }),
});
const ErrorEventSchema = z.looseObject({ type: z.literal("error"), error: z.unknown() });

export interface ParsedOpenCodeOutput {
  text: string;
  costUsd?: number;
  tokens?: { input: number; output: number };
  errors: string[];
  events: number;
}

function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const o = e as { data?: { message?: unknown }; message?: unknown; name?: unknown };
    const msg = o.data?.message ?? o.message;
    if (typeof msg === "string") return typeof o.name === "string" ? `${o.name}: ${msg}` : msg;
  }
  return JSON.stringify(e);
}

export function parseOpenCodeOutput(stdout: string): ParsedOpenCodeOutput {
  const texts: string[] = [];
  const errors: string[] = [];
  let cost: number | undefined;
  let input: number | undefined;
  let output: number | undefined;
  let events = 0;
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let json: unknown;
    try {
      json = JSON.parse(t);
    } catch {
      continue;
    }
    if (!EventSchema.safeParse(json).success) continue;
    events++;
    const text = TextEventSchema.safeParse(json);
    if (text.success) texts.push(text.data.part.text);
    const step = StepFinishSchema.safeParse(json);
    if (step.success) {
      const p = step.data.part;
      if (p.cost !== undefined) cost = (cost ?? 0) + p.cost;
      if (p.tokens?.input !== undefined || p.tokens?.cache) {
        input =
          (input ?? 0) +
          (p.tokens.input ?? 0) +
          (p.tokens.cache?.read ?? 0) +
          (p.tokens.cache?.write ?? 0);
      }
      if (p.tokens?.output !== undefined) output = (output ?? 0) + p.tokens.output;
    }
    const err = ErrorEventSchema.safeParse(json);
    if (err.success) errors.push(errorMessage(err.data.error));
  }
  return {
    text: texts.join("\n").trim(),
    ...(cost !== undefined ? { costUsd: cost } : {}),
    ...(input !== undefined || output !== undefined
      ? { tokens: { input: input ?? 0, output: output ?? 0 } }
      : {}),
    errors,
    events,
  };
}

/**
 * Returns the LAST top-level JSON object in a text (a fenced ```json block or bare braces),
 * or undefined. Only extraction — validation is the caller's job (Zod).
 */
export function extractLastJsonObject(text: string): unknown {
  let found: unknown;
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try {
          found = JSON.parse(text.slice(start, i + 1));
          start = i; // continue after this object
        } catch {
          // not JSON; try the next "{"
        }
        break;
      }
    }
  }
  return found;
}

export interface OpenCodeRuntimeOptions {
  /** Executable; default OPENCODE_BIN or the project's node_modules/.bin/opencode. */
  bin: string;
  binArgs?: string[];
  /** Env var names with this runtime's provider keys (passed to the process, masked in logs). */
  keyEnv: readonly string[];
  logDir: string;
}

export class OpenCodeRuntime implements AgentRuntime {
  readonly name = "opencode";
  private seq = 0;
  constructor(private readonly options: OpenCodeRuntimeOptions) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    if (input.role === "developer")
      throw new Error("OpenCodeRuntime is read-only; it cannot run the developer");
    assertToolsAllowed(input.role, input.allowedTools);
    if (!input.model) throw new Error("OpenCodeRuntime needs an explicit provider/model");

    const message = [
      input.systemPrompt ? `# Instructions\n\n${input.systemPrompt}` : "",
      input.prompt,
      input.outputSchema
        ? "## Answer format\n\nReply with ONLY one JSON object matching this JSON Schema (no prose, no code fences):\n" +
          JSON.stringify(input.outputSchema)
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const args = [
      "run",
      "--format",
      "json",
      "--pure",
      "-m",
      input.model,
      "--dir",
      input.cwd,
      message,
    ];

    const env = opencodeEnv(this.options.keyEnv);
    const redact = createRedactor(this.options.keyEnv.map((k) => env[k]));
    const logPath =
      input.logPath ??
      path.join(this.options.logDir, `${String(++this.seq).padStart(2, "0")}-${input.role}.jsonl`);
    await mkdir(path.dirname(logPath), { recursive: true });
    await writeFile(
      `${logPath}.input.json`,
      redact(
        JSON.stringify(
          { bin: this.options.bin, model: input.model, cwd: input.cwd, message },
          null,
          2,
        ),
      ),
    );

    const proc = await runCommand(this.options.bin, [...(this.options.binArgs ?? []), ...args], {
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      env,
      killTree: true,
    });
    await writeFile(logPath, redact(proc.stdout));
    if (proc.stderr) await writeFile(`${logPath}.stderr`, redact(proc.stderr));
    return interpretOpenCodeRun(proc, input, logPath, redact);
  }
}

export function interpretOpenCodeRun(
  proc: CommandResult,
  input: Pick<AgentRunInput, "outputSchema" | "timeoutMs">,
  rawLogPath: string,
  redact: (s: string) => string = (s) => s,
): AgentRunResult {
  const parsed = parseOpenCodeOutput(proc.stdout);
  const base = {
    durationMs: proc.durationMs,
    rawLogPath,
    permissionDenials: [],
    output: redact(parsed.text),
    ...(parsed.costUsd !== undefined ? { costUsd: parsed.costUsd } : {}),
    ...(parsed.tokens ? { tokens: parsed.tokens } : {}),
  };
  const fail = (kind: "timeout" | "process" | "parse", message: string): AgentRunResult => ({
    ...base,
    ok: false,
    error: { kind, message: redact(message) },
  });
  if (proc.timedOut) return fail("timeout", `agent did not finish within ${input.timeoutMs} ms`);
  if (proc.spawnError !== undefined)
    return fail("process", `failed to start opencode: ${proc.spawnError}`);
  if (proc.exitCode !== 0 || parsed.errors.length > 0) {
    const why = parsed.errors.join("; ") || proc.stderr.trim().split("\n").slice(-5).join("\n");
    return fail("process", `opencode exited with code ${proc.exitCode ?? "null"}: ${why}`);
  }
  if (parsed.events === 0) return fail("parse", "opencode produced no JSON events");
  if (input.outputSchema !== undefined) {
    const structured = extractLastJsonObject(parsed.text);
    if (structured === undefined)
      return fail("parse", "no JSON object found in the agent's answer");
    return { ...base, ok: true, structured };
  }
  return { ...base, ok: true };
}
