import { z } from "zod";
import { SpecChangeSchema } from "./spec.js";

const plannerFields = {
  plan: z.string().trim().min(1),
  files_to_change: z.array(z.string().trim().min(1)),
  risks: z.array(z.string().trim().min(1)),
  questions: z.array(z.string().trim().min(1)),
};

/** Up to 3 short, general project rules implied by human feedback on a spec. */
const LessonsSchema = z.array(z.string().trim().min(1).max(300)).max(3);

/**
 * Planner answer. Non-empty `questions` stops the run with `needs_clarification`; otherwise
 * `spec` (the OpenSpec change proposal, rendered by the factory) is required. The spec's
 * content is validated later, in `spec_draft` (`checkSpec`), so an invalid spec gets the
 * single fix attempt instead of failing the whole planner step. `spec` is optional only so
 * Week 1 reports (which had no spec) stay readable.
 */
export const PlannerOutputSchema = z
  .strictObject({
    ...plannerFields,
    spec: z.unknown().optional(),
    /**
     * After human feedback on a spec: up to 3 short, general project rules it implies (stored
     * in project memory once the revised spec is approved). Empty without feedback.
     */
    lessons: LessonsSchema.default([]),
  })
  .superRefine((p, ctx) => {
    if (p.questions.length === 0 && (p.spec === undefined || p.spec === null)) {
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

/** Shape shown to the agent (full spec structure), stricter than what we parse up front. */
// Every field the factory reads must be in the agent's schema too: Claude Code's structured
// output contains only the schema's properties (lessons was missing here until the final
// block's A-path check showed planners could never return one).
export const plannerJsonSchema = toAgentJsonSchema(
  z.strictObject({ ...plannerFields, spec: SpecChangeSchema.nullable(), lessons: LessonsSchema }),
);
export const reviewerJsonSchema = toAgentJsonSchema(ReviewVerdictSchema);
