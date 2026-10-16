import {
  plannerJsonSchema,
  PlannerOutputSchema,
  toAgentJsonSchema,
  type PlannerOutput,
} from "../schemas/agents.js";
import { SpecChangeSchema, type OpenSpecIssue, type SpecChange } from "../schemas/spec.js";
import type { TaskSpec } from "../schemas/task.js";
import type { AgentRunResult } from "../runtimes/types.js";
import { describeIssues } from "../spec/openspec.js";
import { renderSpecForPrompt, renderTask } from "./prompts.js";
import { parseStructured, type StructuredOutcome } from "./structured.js";

export const PLANNER_OUTPUT_SCHEMA = plannerJsonSchema;
export const SPEC_OUTPUT_SCHEMA = toAgentJsonSchema(SpecChangeSchema);

export function plannerPrompt(task: TaskSpec, rejections: readonly string[] = []): string {
  const parts = [renderTask(task)];
  if (rejections.length > 0) {
    parts.push(
      "## Human feedback on previous specification drafts",
      "A human rejected your previous specification. Address every point below in the new plan and spec:",
      rejections.map((c, i) => `${i + 1}. ${c || "(no comment)"}`).join("\n"),
    );
  }
  parts.push(
    "Explore the repository, then return your plan and spec (or blocking questions) as JSON.",
  );
  return parts.join("\n\n");
}

/** Second (and last) attempt at the spec after `openspec validate` rejected the first one. */
export function specFixPrompt(
  task: TaskSpec,
  previous: SpecChange,
  issues: readonly OpenSpecIssue[],
): string {
  return [
    renderTask(task),
    "## Your previous specification JSON",
    "```json\n" + JSON.stringify(previous, null, 2) + "\n```",
    "## `openspec validate --strict` output",
    describeIssues(issues) || "(no issue details)",
    "Return a corrected specification JSON (same schema) that fixes every issue above. Keep the requirements' meaning.",
  ].join("\n\n");
}

export function parsePlannerResult(result: AgentRunResult): StructuredOutcome<PlannerOutput> {
  return parseStructured(result, PlannerOutputSchema);
}

export function parseSpecResult(result: AgentRunResult): StructuredOutcome<SpecChange> {
  return parseStructured(result, SpecChangeSchema);
}

export { renderSpecForPrompt };
