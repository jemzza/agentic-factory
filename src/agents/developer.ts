import type { PlannerOutput, ReviewIssue } from "../schemas/agents.js";
import type { TaskContent } from "../schemas/task.js";
import { renderSpecForPrompt, renderTask } from "./prompts.js";

export interface FixFeedback {
  cycle: number;
  maxCycles: number;
  /** Gate failures (scope + check output), already formatted. Empty if the gate passed. */
  gateFailures: string;
  /** Reviewer issues and unmet criteria. Empty if no review happened. */
  reviewIssues: ReviewIssue[];
  unmetCriteria: { criterion: string; evidence: string }[];
}

function renderPlan(plan: PlannerOutput): string {
  return [
    "## Plan (from the planner)",
    plan.plan.trim(),
    "### Files expected to change",
    plan.files_to_change.length
      ? plan.files_to_change.map((f) => `- \`${f}\``).join("\n")
      : "- (none listed)",
    "### Risks to watch",
    plan.risks.length ? plan.risks.map((r) => `- ${r}`).join("\n") : "- (none listed)",
  ].join("\n\n");
}

export function developerPrompt(
  task: TaskContent,
  plan: PlannerOutput,
  feedback?: FixFeedback,
  specFiles: Readonly<Record<string, string>> = {},
): string {
  const parts = [renderTask(task)];
  if (Object.keys(specFiles).length > 0) parts.push(renderSpecForPrompt(specFiles));
  parts.push(renderPlan(plan));
  if (feedback) {
    parts.push(
      `## Fix cycle ${feedback.cycle} of ${feedback.maxCycles}`,
      "Your previous attempt is already in the working tree but was NOT accepted. " +
        "Fix every problem below, keep what already works, then run `npm run check` again.",
    );
    if (feedback.gateFailures) {
      parts.push(
        "### Quality Gate failures (checks run independently in a sandbox)",
        feedback.gateFailures,
      );
    }
    if (feedback.unmetCriteria.length) {
      parts.push(
        "### Acceptance criteria the reviewer found unmet",
        feedback.unmetCriteria
          .map((c) => `- ${c.criterion}\n  - Reviewer: ${c.evidence}`)
          .join("\n"),
      );
    }
    if (feedback.reviewIssues.length) {
      parts.push(
        "### Reviewer issues",
        feedback.reviewIssues
          .map((i) => `- [${i.severity}] ${i.file ? `\`${i.file}\`: ` : ""}${i.description}`)
          .join("\n"),
      );
    }
  } else {
    parts.push("Implement the task now. Finish with a short summary of what you changed.");
  }
  return parts.join("\n\n");
}
