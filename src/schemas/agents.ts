import { z } from "zod";
import { SpecChangeSchema } from "./spec.js";

/**
 * Planner answer. Non-empty `questions` stops the run with `needs_clarification`; otherwise
 * `spec` (the OpenSpec change proposal, rendered by the factory) is required. `spec` is
 * optional in the schema only so Week 1 reports (which had no spec) stay readable.
 */
export const PlannerOutputSchema = z
  .strictObject({
    plan: z.string().trim().min(1),
    files_to_change: z.array(z.string().trim().min(1)),
    risks: z.array(z.string().trim().min(1)),
    questions: z.array(z.string().trim().min(1)),
    spec: SpecChangeSchema.nullable().optional(),
  })
  .superRefine((p, ctx) => {
    if (p.questions.length === 0 && !p.spec) {
      ctx.addIssue({
        code: "custom",
        path: ["spec"],
        message: "spec is required when there are no questions",
      });
    }
  });
export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

export const ISSUE_SEVERITIES = ["blocker", "major", "minor"] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];

export const ReviewIssueSchema = z.strictObject({
  severity: z.enum(ISSUE_SEVERITIES),
  file: z.string(),
  description: z.string().trim().min(1),
});
export type ReviewIssue = z.infer<typeof ReviewIssueSchema>;

export const CriterionCheckSchema = z.strictObject({
  criterion: z.string().trim().min(1),
  met: z.boolean(),
  evidence: z.string().trim().min(1),
});
export type CriterionCheck = z.infer<typeof CriterionCheckSchema>;

/** Reviewer answer as returned by the agent. */
export const ReviewVerdictSchema = z.strictObject({
  verdict: z.enum(["approve", "request_changes"]),
  issues: z.array(ReviewIssueSchema),
  criteria_check: z.array(CriterionCheckSchema),
});
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

/**
 * JSON Schema for the agent CLI (`--json-schema`), generated from the Zod schema so the two
 * never drift; Zod stays the source of truth for validation. Claude Code 2.1.300 rejects
 * the draft 2020-12 `$schema` URI that Zod emits by default, so we emit draft-07 and drop
 * the `$schema` key.
 */
export function toAgentJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  delete json["$schema"];
  return json;
}

export const plannerJsonSchema = toAgentJsonSchema(PlannerOutputSchema);
export const reviewerJsonSchema = toAgentJsonSchema(ReviewVerdictSchema);
