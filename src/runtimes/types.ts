export const AGENT_ROLES = ["planner", "developer", "reviewer"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export interface AgentRunInput {
  role: AgentRole;
  /** User prompt (sent on stdin). */
  prompt: string;
  /** Working directory: the task's worktree. File access is confined to it. */
  cwd: string;
  /**
   * Tools the agent may use. Bare names (`Read`, `Edit`) enable a tool within `cwd`;
   * `Bash(<command>)` entries allow exactly that command. Planner and reviewer are
   * restricted to read-only tools (see tool-policy.ts).
   */
  allowedTools: string[];
  timeoutMs: number;
  /** Role instructions + target repo conventions, appended to the runtime's system prompt. */
  systemPrompt?: string;
  /**
   * JSON Schema the final answer must match. When set, the runtime returns the parsed
   * object in `structured`; callers still validate it with Zod.
   */
  outputSchema?: Record<string, unknown>;
  /** Hard spend cap for this call (USD). */
  maxBudgetUsd?: number;
  /** Model override for this call. */
  model?: string;
  /** Where to write the raw log. Defaults to a file under the runtime's log directory. */
  logPath?: string;
}

export type AgentErrorKind = "timeout" | "process" | "parse" | "budget";

export interface PermissionDenial {
  tool: string;
  input: unknown;
}

export interface AgentRunResult {
  ok: boolean;
  /** Final agent text (for structured runs: the JSON text of `structured`). */
  output: string;
  /** Parsed structured answer when `outputSchema` was given (not yet Zod-validated). */
  structured?: unknown;
  costUsd?: number;
  /** `input` includes cached input tokens (cache reads + cache writes). */
  tokens?: { input: number; output: number };
  durationMs: number;
  numTurns?: number;
  /** Tool calls the permission system refused — evidence of attempted out-of-scope actions. */
  permissionDenials: PermissionDenial[];
  /** Full raw log (stream-json), saved under runs/. */
  rawLogPath: string;
  error?: { kind: AgentErrorKind; message: string };
}

/**
 * A coding-agent backend. Claude Code today; OpenCode / Pi later implement the same
 * contract. Implementations never throw for agent failures (timeout, crash, bad output):
 * those come back as `ok: false` with `error`.
 */
export interface AgentRuntime {
  readonly name: string;
  run(input: AgentRunInput): Promise<AgentRunResult>;
}
