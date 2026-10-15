import { z } from "zod";

export const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Hard cap from the factory rules: never more than 2 fix cycles per task. */
export const MAX_FIX_CYCLES = 2;

/** Visible task definition: `evals/tasks/<id>/task.yaml`. This is what agents see. */
export const TaskSpecSchema = z.strictObject({
  id: z.string().regex(TASK_ID_PATTERN, "id must be kebab-case"),
  title: z.string().trim().min(1),
  request: z.string().trim().min(1),
  acceptance_criteria: z.array(z.string().trim().min(1)).min(1),
  scope: z.strictObject({
    allowed_paths: z.array(z.string().trim().min(1)).min(1),
  }),
  budget: z.strictObject({
    max_fix_cycles: z.number().int().min(0).max(MAX_FIX_CYCLES),
    max_cost_usd: z.number().positive(),
    timeout_minutes: z.number().positive(),
  }),
});
export type TaskSpec = z.infer<typeof TaskSpecSchema>;

export const EXPECTED_OUTCOMES = ["implemented", "needs_clarification"] as const;
export type ExpectedOutcome = (typeof EXPECTED_OUTCOMES)[number];

/**
 * Eval-only metadata: `evals/hidden/<id>/meta.yaml`. Never shown to agents,
 * because difficulty, traps, and the expected outcome would leak the answer.
 */
export const EvalMetaSchema = z.strictObject({
  difficulty: z.enum(["simple", "medium", "hard"]),
  expected_outcome: z.enum(EXPECTED_OUTCOMES),
  traps: z.array(z.string().trim().min(1)),
});
export type EvalMeta = z.infer<typeof EvalMetaSchema>;
