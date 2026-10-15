import { reviewerJsonSchema, ReviewVerdictSchema, type ReviewVerdict } from "../schemas/agents.js";
import type { TaskSpec } from "../schemas/task.js";
import type { AgentRunResult } from "../runtimes/types.js";
import { renderTask } from "./prompts.js";
import { parseStructured, type StructuredOutcome } from "./structured.js";

export const REVIEWER_OUTPUT_SCHEMA = reviewerJsonSchema;

/**
 * Reviewer input: task, criteria and the diff only — never the developer's messages.
 */
export function reviewerPrompt(task: TaskSpec, diff: string, maxDiffChars: number): string {
  const truncated = diff.length > maxDiffChars;
  const shown = truncated ? diff.slice(0, maxDiffChars) : diff;
  return [
    renderTask(task),
    "## Diff under review (base → proposed change)",
    truncated
      ? `The diff is ${diff.length} characters; only the first ${maxDiffChars} are shown. Read the changed files in the working directory for the rest.`
      : "",
    "```diff\n" + shown + "\n```",
    "Review the change and return your verdict as JSON.",
  ]
    .filter((p) => p !== "")
    .join("\n\n");
}

export function parseReviewerResult(
  result: AgentRunResult,
  task: TaskSpec,
): StructuredOutcome<ReviewVerdict> {
  const parsed = parseStructured(result, ReviewVerdictSchema);
  if (!parsed.ok) return parsed;
  const expected = task.acceptance_criteria.length;
  const got = parsed.value.criteria_check.length;
  if (got !== expected) {
    return {
      ok: false,
      error: {
        kind: "invalid_response",
        message: `reviewer checked ${got} criteria, expected exactly ${expected}`,
      },
    };
  }
  return parsed;
}

/**
 * The factory's acceptance decision. An `approve` that contradicts the reviewer's own
 * findings (an unmet criterion or a blocker/major issue) is not an approval.
 */
export function isApproved(review: ReviewVerdict): boolean {
  return (
    review.verdict === "approve" &&
    review.criteria_check.every((c) => c.met) &&
    review.issues.every((i) => i.severity === "minor")
  );
}
