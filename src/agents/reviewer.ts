import { reviewerJsonSchema, ReviewVerdictSchema, type ReviewVerdict } from "../schemas/agents.js";
import type { TaskSpec } from "../schemas/task.js";
import type { AgentRunResult } from "../runtimes/types.js";
import { renderSpecForPrompt, renderTask } from "./prompts.js";
import { parseStructured, type StructuredOutcome } from "./structured.js";

export const REVIEWER_OUTPUT_SCHEMA = reviewerJsonSchema;

/**
 * Reviewer input: task, criteria and the diff only — never the developer's messages.
 */
export function reviewerPrompt(
  task: TaskSpec,
  diff: string,
  maxDiffChars: number,
  specFiles: Readonly<Record<string, string>> = {},
): string {
  const truncated = diff.length > maxDiffChars;
  const shown = truncated ? diff.slice(0, maxDiffChars) : diff;
  const hasSpec = Object.keys(specFiles).length > 0;
  return [
    renderTask(task),
    hasSpec ? renderSpecForPrompt(specFiles) : "",
    hasSpec
      ? "Check the diff against BOTH the approved specification (every requirement and scenario) and the acceptance criteria. A requirement of the spec that is not implemented is a blocker."
      : "",
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

/**
 * Runs the reviewer and, if its answer is not a valid verdict (no JSON, wrong schema, criteria
 * missing), asks once more with the problem spelled out. A second invalid answer is returned
 * as the error. Other failures (timeout, process, budget) are not retried. Shared by the
 * graph's review node and `npm run eval:review`, so both judge reviewers the same way.
 */
export async function reviewWithRetry(
  call: (prompt: string) => Promise<AgentRunResult>,
  prompt: string,
  task: TaskSpec,
  log: (message: string) => void = () => undefined,
): Promise<{ outcome: StructuredOutcome<ReviewVerdict>; attempts: number }> {
  const judge = (res: AgentRunResult): StructuredOutcome<ReviewVerdict> =>
    res.ok
      ? parseReviewerResult(res, task)
      : { ok: false, error: res.error ?? { kind: "process", message: "agent run failed" } };
  let outcome = judge(await call(prompt));
  if (
    !outcome.ok &&
    (outcome.error.kind === "parse" || outcome.error.kind === "invalid_response")
  ) {
    log(`  review: invalid answer (${outcome.error.message.slice(0, 120)}); retrying once`);
    outcome = judge(
      await call(
        `${prompt}\n\n## Your previous answer could not be used\n\n${outcome.error.message}\n\nReply again with ONLY the JSON verdict matching the schema.`,
      ),
    );
    return { outcome, attempts: 2 };
  }
  return { outcome, attempts: 1 };
}
