import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { runCommand, type CommandResult } from "../process/run-command.js";
import {
  exitIsProviderUnavailable,
  resultIsProviderUnavailable,
  timeoutIsProviderUnavailable,
  hostSuspendedMessage,
} from "./provider-errors.js";
import { assertToolsAllowed, parseToolEntry, SECRET_PATH_PATTERNS } from "./tool-policy.js";
import type {
  AgentRole,
  AgentRunInput,
  AgentRunResult,
  AgentRuntime,
  PermissionDenial,
} from "./types.js";

/*
 * Claude Code headless adapter. Flags verified against `claude --help` (v2.1.300) and live
 * probes (Phase 0/5):
 *
 *   claude -p --output-format stream-json --verbose ...      prompt on stdin
 *
 * stdout is JSON Lines. Events include {type:"system",subtype:"init"}, assistant/user
 * messages, {type:"system",subtype:"permission_denied"}, {type:"system",subtype:"api_retry"}
 * (the API did not answer yet; format in provider-errors.ts), and exactly one
 * {type:"result", ...} which is NOT necessarily the last line (a trailing
 * {type:"system",subtype:"task_summary"} may follow). The result event carries:
 *   subtype: "success" | "error_max_budget_usd" | "error_max_turns" | "error_during_execution" | ...
 *   is_error, result (final text), structured_output (with --json-schema),
 *   total_cost_usd, usage {input_tokens, output_tokens, cache_read_input_tokens,
 *   cache_creation_input_tokens}, num_turns, permission_denials [{tool_name, tool_input}],
 *   terminal_reason ("completed" | "budget_exhausted" | ...), errors [string],
 *   modelUsage {<resolved model id>: {...}} (e.g. "claude-opus-5-5" for --model opus).
 * Exit code is 0 on success and 1 on an error result (e.g. budget exhausted).
 * --max-budget-usd is checked between turns, so the final cost may exceed it.
 *
 * Isolation choices (verified by probes):
 * - --setting-sources "" : no user/project settings, hooks or permission rules from the
 *   target repo; this also disables CLAUDE.md auto-loading, so the factory injects the
 *   target's conventions via --append-system-prompt instead.
 * - No bare allow rules for file tools: a bare `Read` allow rule permits reading outside
 *   the working directory. Without rules, reads are confined to cwd.
 * - Read-only roles: --permission-mode dontAsk (anything not pre-approved is denied).
 * - Developer: --permission-mode acceptEdits (edits inside cwd only) + exact Bash allow rules;
 *   --permission-prompts none denies everything else instead of waiting for a human.
 */

const ResultEventSchema = z.looseObject({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
  total_cost_usd: z.number().nonnegative().optional(),
  usage: z
    .looseObject({
      input_tokens: z.number(),
      output_tokens: z.number(),
      cache_read_input_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
    })
    .optional(),
  num_turns: z.number().optional(),
  permission_denials: z
    .array(z.looseObject({ tool_name: z.string(), tool_input: z.unknown() }))
    .optional(),
  terminal_reason: z.string().optional(),
  errors: z.array(z.string()).optional(),
  /** Keys are the models that actually answered (aliases resolved). */
  modelUsage: z.record(z.string(), z.unknown()).optional(),
  /**
   * Set when the API refused the call (observed: 429 + "usage_limit_reached", 2.1.300).
   * A successful result carries `"api_error_status": null` (observed), so both are nullish.
   */
  api_error_status: z.number().nullish(),
  api_error: z.string().nullish(),
});
type ResultEvent = z.infer<typeof ResultEventSchema>;

/** The provider refused the call; the patterns live in provider-errors.ts. */
export function isProviderUnavailable(event: ResultEvent): boolean {
  return resultIsProviderUnavailable(event);
}

export type StreamParse =
  | { kind: "result"; event: ResultEvent }
  | { kind: "missing" }
  | { kind: "invalid"; message: string };

/** Finds and validates the (last) `result` event in stream-json output. */
export function parseStreamJson(stdout: string): StreamParse {
  let found: unknown;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue; // a corrupt non-result line is tolerated; a missing result is not
    }
    if (
      typeof event === "object" &&
      event !== null &&
      (event as { type?: unknown }).type === "result"
    ) {
      found = event;
    }
  }
  if (found === undefined) return { kind: "missing" };
  const parsed = ResultEventSchema.safeParse(found);
  if (!parsed.success) {
    return { kind: "invalid", message: `malformed result event: ${parsed.error.message}` };
  }
  return { kind: "result", event: parsed.data };
}

export interface ClaudeCodeRuntimeOptions {
  /** Executable; default `CLAUDE_BIN` env var or `claude`. */
  bin?: string;
  /** Arguments placed before the Claude Code flags (used to run a fake CLI in tests). */
  binArgs?: string[];
  /** Model per role; default "opus" for all. */
  models?: Partial<Record<AgentRole, string>>;
  /** Directory for raw logs when the input does not specify `logPath`. */
  logDir: string;
}

/**
 * Host environment variables passed to the agent. Everything else (tokens, cloud
 * credentials, ...) is withheld. HOME/USER are needed for the subscription login.
 */
const ENV_ALLOWLIST = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "CLAUDE_CONFIG_DIR",
  "ANTHROPIC_API_KEY",
];

export function agentEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  for (const key of ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Builds Claude Code CLI flags for one run. Pure; validates the role's tool policy. */
export function buildClaudeArgs(input: AgentRunInput, model: string): string[] {
  assertToolsAllowed(input.role, input.allowedTools);
  const parsed = input.allowedTools.map(parseToolEntry);
  const toolNames = [...new Set(parsed.map((t) => t.name))];
  const allowRules = input.allowedTools.filter((_, i) => parsed[i]?.specifier !== undefined);
  const canEdit = toolNames.includes("Edit") || toolNames.includes("Write");
  const denyRules = ["Read", "Edit", "Write"].flatMap((tool) =>
    SECRET_PATH_PATTERNS.map((p) => `${tool}(${p})`),
  );

  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    model,
    "--tools",
    toolNames.join(","),
    "--permission-mode",
    input.role === "developer" && canEdit ? "acceptEdits" : "dontAsk",
    "--permission-prompts",
    "none",
    "--disallowedTools",
    ...denyRules,
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--disable-slash-commands",
  ];
  if (allowRules.length > 0) args.push("--allowedTools", ...allowRules);
  if (input.systemPrompt !== undefined) args.push("--append-system-prompt", input.systemPrompt);
  if (input.outputSchema !== undefined)
    args.push("--json-schema", JSON.stringify(input.outputSchema));
  if (input.maxBudgetUsd !== undefined) args.push("--max-budget-usd", String(input.maxBudgetUsd));
  return args;
}

function tail(text: string, lines = 20): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}

/** Maps a finished process + its parsed stream to an AgentRunResult (pure). */
export function interpretRun(
  proc: CommandResult,
  input: Pick<AgentRunInput, "outputSchema" | "timeoutMs">,
  rawLogPath: string,
): AgentRunResult {
  const base = {
    durationMs: proc.durationMs,
    rawLogPath,
    permissionDenials: [] as PermissionDenial[],
  };
  const parse = parseStreamJson(proc.stdout);
  const event = parse.kind === "result" ? parse.event : undefined;

  const metrics = event
    ? {
        ...(event.total_cost_usd !== undefined && { costUsd: event.total_cost_usd }),
        ...(event.usage && {
          tokens: {
            input:
              event.usage.input_tokens +
              (event.usage.cache_read_input_tokens ?? 0) +
              (event.usage.cache_creation_input_tokens ?? 0),
            output: event.usage.output_tokens,
          },
        }),
        ...(event.num_turns !== undefined && { numTurns: event.num_turns }),
        ...(event.modelUsage && { modelsUsed: Object.keys(event.modelUsage).sort() }),
        permissionDenials: (event.permission_denials ?? []).map((d) => ({
          tool: d.tool_name,
          input: d.tool_input,
        })),
      }
    : {};
  const fail = (
    kind: NonNullable<AgentRunResult["error"]>["kind"],
    message: string,
  ): AgentRunResult => ({
    ...base,
    ...metrics,
    ok: false,
    output: event?.result ?? "",
    error: { kind, message },
  });

  // A step that did not succeed while the host slept is infrastructure, whatever else failed.
  const suspended = hostSuspendedMessage(proc);
  if (suspended && (proc.timedOut || !event || event.is_error)) return fail("infra", suspended);
  if (proc.timedOut) {
    // Only init + api_retry events before the kill: the API never answered (see provider-errors.ts).
    if (timeoutIsProviderUnavailable(proc.stdout)) {
      return fail(
        "infra",
        `provider unavailable: API never answered (only api_retry events) within ${input.timeoutMs} ms`,
      );
    }
    return fail("timeout", `agent did not finish within ${input.timeoutMs} ms`);
  }
  if (proc.spawnError !== undefined)
    return fail("process", `failed to start agent: ${proc.spawnError}`);
  if (parse.kind === "invalid") return fail("parse", parse.message);
  if (!event) {
    if (exitIsProviderUnavailable(proc.exitCode, proc.stderr)) {
      return fail(
        "infra",
        `provider unreachable (exit ${proc.exitCode ?? "null"}): ${tail(proc.stderr)}`,
      );
    }
    return proc.exitCode === 0
      ? fail("parse", "agent output has no result event")
      : fail(
          "process",
          `agent exited with code ${proc.exitCode ?? "null"}: ${tail(proc.stderr || proc.stdout)}`,
        );
  }
  if (event.subtype === "error_max_budget_usd" || event.terminal_reason === "budget_exhausted") {
    return fail("budget", (event.errors ?? []).join("; ") || "agent budget exhausted");
  }
  if (isProviderUnavailable(event)) {
    const why = (event.errors ?? []).join("; ") || event.result || event.subtype;
    const code = event.api_error ?? `HTTP ${String(event.api_error_status)}`;
    return fail("infra", `provider unavailable (${code}): ${why}`);
  }
  if (event.is_error || event.subtype !== "success") {
    const why = (event.errors ?? []).join("; ") || event.result || event.subtype;
    return fail("process", `agent run failed (${event.subtype}): ${why}`);
  }
  if (proc.exitCode !== 0) {
    return fail(
      "process",
      `agent reported success but exited with code ${proc.exitCode ?? "null"}`,
    );
  }
  if (input.outputSchema !== undefined) {
    if (event.structured_output === undefined)
      return fail("parse", "agent returned no structured output");
    return {
      ...base,
      ...metrics,
      ok: true,
      output: JSON.stringify(event.structured_output),
      structured: event.structured_output,
    };
  }
  return { ...base, ...metrics, ok: true, output: event.result ?? "" };
}

export class ClaudeCodeRuntime implements AgentRuntime {
  readonly name = "claude-code";
  private readonly bin: string;
  private readonly binArgs: string[];
  private seq = 0;

  constructor(private readonly options: ClaudeCodeRuntimeOptions) {
    this.bin = options.bin ?? process.env["CLAUDE_BIN"] ?? "claude";
    this.binArgs = options.binArgs ?? [];
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const model = input.model ?? this.options.models?.[input.role] ?? "opus";
    const args = buildClaudeArgs(input, model);
    const logPath =
      input.logPath ??
      path.join(this.options.logDir, `${String(++this.seq).padStart(2, "0")}-${input.role}.jsonl`);
    await mkdir(path.dirname(logPath), { recursive: true });
    await writeFile(
      `${logPath}.input.json`,
      JSON.stringify({ bin: this.bin, args, cwd: input.cwd, prompt: input.prompt }, null, 2),
    );

    const proc = await runCommand(this.bin, [...this.binArgs, ...args], {
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      env: agentEnv(),
      input: input.prompt,
      killTree: true,
    });

    await writeFile(logPath, proc.stdout);
    if (proc.stderr) await writeFile(`${logPath}.stderr`, proc.stderr);
    return interpretRun(proc, input, logPath);
  }
}
