import { z } from "zod";

export const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Cycle budgets: the single place that defines their defaults and hard cap.
 * Gate fix cycles follow a failed quality gate (checks, scope, policies); review cycles
 * follow a reviewer verdict of `request_changes`. They are counted and capped separately.
 */
export const DEFAULT_MAX_GATE_FIX_CYCLES = 2;
export const DEFAULT_MAX_REVIEW_CYCLES = 1;
/** Hard cap from the factory rules: never more than 2 cycles of either kind per task. */
export const MAX_CYCLES_PER_KIND = 2;

const LEGACY_FIX_CYCLES_MESSAGE =
  "max_fix_cycles is no longer supported: use max_gate_fix_cycles " +
  `(fix cycles after a failed quality gate, default ${DEFAULT_MAX_GATE_FIX_CYCLES}) and ` +
  `max_review_cycles (fix cycles after reviewer request_changes, default ${DEFAULT_MAX_REVIEW_CYCLES})`;

const cycleLimit = (fallback: number) =>
  z.number().int().min(0).max(MAX_CYCLES_PER_KIND).default(fallback);

export const TaskBudgetSchema = z.strictObject({
  max_gate_fix_cycles: cycleLimit(DEFAULT_MAX_GATE_FIX_CYCLES),
  max_review_cycles: cycleLimit(DEFAULT_MAX_REVIEW_CYCLES),
  max_cost_usd: z.number().positive(),
  timeout_minutes: z.number().positive(),
});
export type TaskBudget = z.infer<typeof TaskBudgetSchema>;

/**
 * Budget of runs recorded before the split (one shared `max_fix_cycles`). Only for reading
 * stored reports and checkpoints; a task file with this shape is rejected.
 */
export const LegacyTaskBudgetSchema = z.strictObject({
  max_fix_cycles: z.number().int().min(0).max(MAX_CYCLES_PER_KIND),
  max_cost_usd: z.number().positive(),
  timeout_minutes: z.number().positive(),
});
export type LegacyTaskBudget = z.infer<typeof LegacyTaskBudgetSchema>;

/** Task-file budget: the old shared field is an error that names the new fields. */
const TaskFileBudgetSchema = z.preprocess((value, ctx) => {
  if (typeof value === "object" && value !== null && "max_fix_cycles" in value) {
    ctx.addIssue({ code: "custom", message: LEGACY_FIX_CYCLES_MESSAGE, path: ["max_fix_cycles"] });
    // Drop the key so the strict schema reports only this message, not "unrecognized key".
    return Object.fromEntries(Object.entries(value).filter(([k]) => k !== "max_fix_cycles"));
  }
  return value;
}, TaskBudgetSchema);

const taskFields = {
  id: z.string().regex(TASK_ID_PATTERN, "id must be kebab-case"),
  title: z.string().trim().min(1),
  request: z.string().trim().min(1),
  acceptance_criteria: z.array(z.string().trim().min(1)).min(1),
  scope: z.strictObject({
    allowed_paths: z.array(z.string().trim().min(1)).min(1),
  }),
};

/** Visible task definition: `evals/tasks/<id>/task.yaml`. This is what agents see. */
export const TaskSpecSchema = z.strictObject({ ...taskFields, budget: TaskFileBudgetSchema });
export type TaskSpec = z.infer<typeof TaskSpecSchema>;

/** A task as stored in run state and reports: current budget, or the pre-split one. */
export const StoredTaskSpecSchema = z.strictObject({
  ...taskFields,
  budget: z.union([TaskBudgetSchema, LegacyTaskBudgetSchema]),
});
export type StoredTaskSpec = z.infer<typeof StoredTaskSpecSchema>;

/** What agents are shown: everything but the budget. */
export type TaskContent = Omit<StoredTaskSpec, "budget">;

/** Cycle limits of a stored task; null for a run recorded with the pre-split budget. */
export function cycleLimits(
  budget: StoredTaskSpec["budget"],
): { gateFix: number; review: number } | null {
  return "max_fix_cycles" in budget
    ? null
    : { gateFix: budget.max_gate_fix_cycles, review: budget.max_review_cycles };
}

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
