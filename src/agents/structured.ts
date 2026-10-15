import type { z } from "zod";
import type { AgentRunResult } from "../runtimes/types.js";

export type StructuredOutcome<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: {
        kind: "timeout" | "process" | "parse" | "budget" | "invalid_response";
        message: string;
      };
    };

/**
 * Validates a structured agent answer with Zod. An answer that does not match the schema
 * is a step error (`invalid_response`) — never repaired or guessed.
 */
export function parseStructured<S extends z.ZodType>(
  result: AgentRunResult,
  schema: S,
): StructuredOutcome<z.output<S>> {
  if (!result.ok) {
    return { ok: false, error: result.error ?? { kind: "process", message: "agent run failed" } };
  }
  const parsed = schema.safeParse(result.structured);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        kind: "invalid_response",
        message: `agent answer does not match schema: ${parsed.error.message}`,
      },
    };
  }
  return { ok: true, value: parsed.data };
}
