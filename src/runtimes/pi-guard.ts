/*
 * Pi extension loaded by the factory into every Pi run (`pi --no-extensions -e <this file>`).
 * Pi itself has no path confinement: its `read` tool reads any file the process can read, so
 * this `tool_call` handler is the boundary for read-only roles. A call is BLOCKED when:
 * - the tool is not one of read, grep, find, ls (also enforced by `--tools`);
 * - a path resolves (symlinks followed) outside the working directory, or names a secret
 *   file (.env*, *.pem, *.key), or starts with `~`;
 * - a grep `glob` or a find `pattern` could reach outside (`..`, absolute, `~`) or names a
 *   secret file.
 * A handler failure also blocks the call (Pi's fail-safe). Blocked calls come back to the
 * model as an error result whose text starts with BLOCK_PREFIX; the adapter reports them as
 * permission denials.
 *
 * Structured output: when FACTORY_PI_RESPONSE_SCHEMA holds a JSON Schema, every request to the
 * provider gets `response_format: {type: "json_schema", ...}` (OpenAI-compatible endpoints,
 * e.g. Ollama's /v1). The adapter then runs Pi with `--no-tools`: a constrained JSON answer
 * and tool calls exclude each other.
 *
 * Self-contained on purpose (Node built-ins only): Pi loads it with jiti, outside our build.
 */
import { realpathSync } from "node:fs";
import path from "node:path";

export const BLOCK_PREFIX = "factory-guard:";
export const PI_READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

const SECRET_NAME = /(^|\/)(\.env[^/]*|[^/]*\.pem|[^/]*\.key)$/i;

/** Real path of `p`, or of its nearest existing ancestor joined with the rest. */
function realish(p: string): string {
  const rest: string[] = [];
  let cur = p;
  for (;;) {
    try {
      return path.join(realpathSync(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

function pathProblem(root: string, raw: string): string | null {
  const p = raw.startsWith("@") ? raw.slice(1) : raw; // Pi accepts an @ prefix
  if (p.startsWith("~")) return `"${raw}" is outside the working directory`;
  if (SECRET_NAME.test(p)) return `"${raw}" is a secret file`;
  const realRoot = realish(root);
  const target = realish(path.resolve(root, p));
  const rel = path.relative(realRoot, target);
  if (rel.startsWith("..") || path.isAbsolute(rel))
    return `"${raw}" is outside the working directory`;
  return null;
}

function patternProblem(raw: string): string | null {
  if (raw.startsWith("/") || raw.startsWith("~") || raw.split(/[\\/]/).includes(".."))
    return `pattern "${raw}" could reach outside the working directory`;
  if (/\.env|\.pem|\.key\b/i.test(raw)) return `pattern "${raw}" names secret files`;
  return null;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Why a tool call must be blocked, or null to allow it. Pure apart from resolving symlinks. */
export function guardToolCall(root: string, toolName: string, input: unknown): string | null {
  if (!(PI_READ_ONLY_TOOLS as readonly string[]).includes(toolName))
    return `tool "${toolName}" is not allowed (read-only role)`;
  const args = (typeof input === "object" && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  const p = str(args["path"]);
  if (toolName === "read" && p === undefined) return "read needs a path";
  if (p !== undefined) {
    const problem = pathProblem(root, p);
    if (problem) return problem;
  }
  const glob = toolName === "grep" ? str(args["glob"]) : undefined;
  const pattern = toolName === "find" ? str(args["pattern"]) : undefined;
  for (const g of [glob, pattern]) {
    if (g === undefined) continue;
    const problem = patternProblem(g);
    if (problem) return problem;
  }
  return null;
}

interface ToolCallEvent {
  toolName: string;
  input: unknown;
}
interface MinimalPi {
  on(
    event: "tool_call",
    handler: (e: ToolCallEvent) => Promise<{ block: true; reason: string } | undefined>,
  ): unknown;
  on(
    event: "before_provider_request",
    handler: (e: { payload: unknown }) => Promise<unknown>,
  ): unknown;
}

export const RESPONSE_SCHEMA_ENV = "FACTORY_PI_RESPONSE_SCHEMA";

/** The provider payload with a JSON Schema response format (non-objects pass unchanged). */
export function withResponseFormat(payload: unknown, schema: Record<string, unknown>): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return payload;
  return {
    ...(payload as Record<string, unknown>),
    response_format: { type: "json_schema", json_schema: { name: "answer", strict: true, schema } },
  };
}

export default function factoryGuard(pi: MinimalPi): void {
  const root = process.cwd(); // the adapter starts Pi in the worktree
  pi.on("tool_call", (e) => {
    const why = guardToolCall(root, e.toolName, e.input);
    return Promise.resolve(why ? { block: true, reason: `${BLOCK_PREFIX} ${why}` } : undefined);
  });
  const raw = process.env[RESPONSE_SCHEMA_ENV];
  if (raw) {
    const schema = JSON.parse(raw) as Record<string, unknown>; // a bad value fails Pi's startup
    pi.on("before_provider_request", (e) => Promise.resolve(withResponseFormat(e.payload, schema)));
  }
}
