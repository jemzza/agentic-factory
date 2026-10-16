import { z } from "zod";
import { PlannerOutputSchema, ReviewVerdictSchema } from "./agents.js";
import { PersistedSpecChangeSchema } from "./spec.js";
import { StoredTaskSpecSchema } from "./task.js";

export const RUN_STATUSES = [
  "success",
  "gate_failed",
  "review_rejected",
  "needs_clarification",
  "timeout",
  "budget_exceeded",
  "error",
  /** The model provider was unavailable (usage/rate limit, outage): not a factory result. */
  "infra_error",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const CheckResultSchema = z.strictObject({
  name: z.string(),
  command: z.array(z.string()),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  passed: z.boolean(),
  /** Last lines of combined output; full output is in `logPath`. */
  outputTail: z.string(),
  logPath: z.string(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const ScopeResultSchema = z.strictObject({
  passed: z.boolean(),
  changedFiles: z.array(z.string()),
  violations: z.array(z.string()),
  /** Gate also fails when the developer changed nothing. */
  empty: z.boolean(),
});
export type ScopeResult = z.infer<typeof ScopeResultSchema>;

export const GateResultSchema = z.strictObject({
  passed: z.boolean(),
  checks: z.array(CheckResultSchema),
  scope: ScopeResultSchema,
  /** Policy violations, e.g. the approved spec was modified (absent in Week 1 reports). */
  policyViolations: z.array(z.string()).default([]),
});
export type GateResult = z.infer<typeof GateResultSchema>;

const AgentErrorSchema = z.strictObject({
  kind: z.enum(["timeout", "process", "parse", "budget", "infra", "invalid_response"]),
  message: z.string(),
});

export const StepResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("agent"),
    role: z.enum(["planner", "developer", "reviewer"]),
    cycle: z.number().int().nonnegative(),
    ok: z.boolean(),
    startedAt: z.string(),
    durationMs: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative().nullable(),
    tokens: z.strictObject({ input: z.number(), output: z.number() }).nullable(),
    numTurns: z.number().int().nullable(),
    permissionDenials: z.array(z.strictObject({ tool: z.string(), input: z.unknown() })),
    rawLogPath: z.string(),
    /** Agent's final message (developer summary; JSON for structured roles). Not evidence. */
    output: z.string(),
    error: AgentErrorSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal("spec"),
    attempt: z.number().int().positive(),
    valid: z.boolean(),
    issues: z.array(z.object({ level: z.string(), message: z.string() }).loose()),
    commit: z.string().nullable(),
  }),
  z.strictObject({
    kind: z.literal("snapshot"),
    cycle: z.number().int().nonnegative(),
    commit: z.string(),
    message: z.string(),
  }),
  z.strictObject({
    kind: z.literal("gate"),
    cycle: z.number().int().nonnegative(),
    startedAt: z.string(),
    durationMs: z.number().int().nonnegative(),
    result: GateResultSchema,
  }),
]);
export type StepResult = z.infer<typeof StepResultSchema>;

/** Why the developer ran again; each reason spends its own cycle budget. */
export const FIX_REASONS = ["gate_failure", "review_feedback"] as const;
export type FixReason = (typeof FIX_REASONS)[number];

export const ReworkSchema = z.strictObject({
  /** Developer run index (1 = first rework), as in step logs. */
  cycle: z.number().int().positive(),
  reason: z.enum(FIX_REASONS),
  /** Position within the budget of this reason (1 = first rework of this kind). */
  ofKind: z.number().int().positive(),
});
export type Rework = z.infer<typeof ReworkSchema>;

export const RunReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.string(),
  status: z.enum(RUN_STATUSES),
  /** Human-readable reason for the status. */
  message: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  /** Wall-clock duration (kept for compatibility; equals wallDurationMs when present). */
  durationMs: z.number().int().nonnegative(),
  /** Time that counts against the task timeout (excludes waiting for humans / downtime). */
  activeDurationMs: z.number().int().nonnegative().optional(),
  /** Full wall-clock time from start to finish. */
  wallDurationMs: z.number().int().nonnegative().optional(),
  task: StoredTaskSpecSchema,
  runtime: z.string(),
  models: z.record(z.string(), z.string()),
  target: z
    .strictObject({ name: z.string(), repoDir: z.string(), baseCommit: z.string() })
    .nullable(),
  worktree: z
    .strictObject({ path: z.string(), branch: z.string(), headCommit: z.string().nullable() })
    .nullable(),
  plan: PlannerOutputSchema.nullable(),
  /** OpenSpec change: structured spec, rendered files, approvals (absent in Week 1 reports). */
  spec: z
    .strictObject({
      changeId: z.string(),
      approvalMode: z.enum(["manual", "auto"]),
      commit: z.string().nullable(),
      valid: z.boolean(),
      attempts: z.number().int(),
      change: PersistedSpecChangeSchema.nullable(),
      files: z.record(z.string(), z.string()),
      rejections: z.array(z.string()),
    })
    .nullable()
    .default(null),
  /** Number of fix cycles performed (0 = first implementation passed or the run stopped earlier). */
  fixCycles: z.number().int().nonnegative(),
  /** Developer re-runs after a failed gate / after reviewer request_changes (absent before the split). */
  gateFixCycles: z.number().int().nonnegative().optional(),
  reviewCycles: z.number().int().nonnegative().optional(),
  /** Every rework in order, with its reason (empty before the split). */
  reworks: z.array(ReworkSchema).default([]),
  /** Human spec rejections (absent before the split). Does not affect firstPass. */
  specRevisions: z.number().int().nonnegative().optional(),
  /**
   * Verified by hidden tests with no rework at all. Only an eval can decide it: null when the
   * pipeline writes the report; the eval fills it in after the hidden tests ran.
   */
  firstPass: z.boolean().nullable().default(null),
  steps: z.array(StepResultSchema),
  /** Final reviewer verdict, if a review happened. */
  review: ReviewVerdictSchema.nullable(),
  /** Final gate result, if the gate ran. */
  gate: GateResultSchema.nullable(),
  cost: z.strictObject({
    totalUsd: z.number().nonnegative(),
    budgetUsd: z.number().positive(),
    /** Agent steps whose cost is unknown (e.g. killed on timeout before reporting). */
    unknownCostSteps: z.number().int().nonnegative(),
  }),
  changedFiles: z.array(z.string()),
  diff: z.string(),
});
export type RunReport = z.infer<typeof RunReportSchema>;
