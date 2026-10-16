import { ReducedValue, StateSchema } from "@langchain/langgraph";
import { z } from "zod";
import { PlannerOutputSchema, ReviewVerdictSchema } from "../schemas/agents.js";
import {
  GateResultSchema,
  ReworkSchema,
  RUN_STATUSES,
  StepResultSchema,
  type StepResult,
} from "../schemas/report.js";
import { OpenSpecIssueSchema, PersistedSpecChangeSchema } from "../schemas/spec.js";
import { StoredTaskSpecSchema } from "../schemas/task.js";

/** Spec rejections a human may send back to planning before the run asks for clarification. */
export const MAX_SPEC_REJECTIONS = 2;
/** Render+validate attempts per plan: the first draft plus one fix by the Planner. */
export const MAX_SPEC_ATTEMPTS = 2;

/** Resume value of the spec_approval interrupt (validated by LangGraph via responseSchema). */
export const SpecApprovalAnswerSchema = z.strictObject({
  decision: z.enum(["approve", "reject"]),
  comment: z.string().optional(),
  actor: z.string().min(1),
});
export type SpecApprovalAnswer = z.infer<typeof SpecApprovalAnswerSchema>;

/** Resume value of the merge_approval interrupt. */
export const MergeAnswerSchema = z.strictObject({
  decision: z.enum(["merge", "close"]),
  comment: z.string().optional(),
  actor: z.string().min(1),
});
export type MergeAnswer = z.infer<typeof MergeAnswerSchema>;

export const MergeOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("merged"),
    mergeCommit: z.string(),
    mainBefore: z.string(),
    archivedAs: z.string().nullable(),
  }),
  /** Not merged; the run goes back to waiting for a human (reason explains what to do). */
  z.strictObject({ kind: z.literal("blocked"), reason: z.string() }),
]);
export type MergeOutcome = z.infer<typeof MergeOutcomeSchema>;

export const NODE_NAMES = [
  "prepare",
  "plan",
  "spec_draft",
  "spec_approval",
  "develop",
  "gate",
  "review",
  "report",
  "merge_approval",
  "merge",
  "close",
] as const;
export type NodeName = (typeof NODE_NAMES)[number];

/**
 * Why a node could not do its job. Agent errors keep the runtime's kind; `sandbox` is a
 * Docker/sandbox infrastructure failure; `exception` is any other unexpected error
 * (git, filesystem, …).
 */
export const StepErrorSchema = z.strictObject({
  node: z.string(),
  kind: z.enum([
    "timeout",
    "process",
    "parse",
    "budget",
    "infra",
    "invalid_response",
    "sandbox",
    "exception",
  ]),
  message: z.string(),
});
export type StepError = z.infer<typeof StepErrorSchema>;

export const TargetRepoSchema = z.strictObject({ dir: z.string(), baseCommit: z.string() });
export const WorktreeSchema = z.strictObject({
  path: z.string(),
  branch: z.string(),
  baseCommit: z.string(),
});

/**
 * Graph state. Field names must differ from node names (LangGraph rule), hence
 * `planResult` / `gateResult` / `reviewVerdict` next to the `plan` / `gate` / `review` nodes.
 * Everything is JSON-serializable (checkpointed in Phase 3); dependencies such
 * as the runtime, the sandbox and the store live in the node context, never in state.
 * All fields are last-value except `steps`, which accumulates the step log.
 */
export const RunState = new StateSchema({
  runId: z.string(),
  /** Stored shape: checkpoints written before the cycle-budget split carry the legacy budget. */
  task: StoredTaskSpecSchema,
  /** Directory for this run's logs and reports (state, so a resumed process can find it). */
  runDir: z.string(),
  mode: z.enum(["interactive", "eval"]).default("interactive"),
  /** "auto" (eval) approves the spec without a human; "manual" interrupts for approval. */
  specApprovalMode: z.enum(["manual", "auto"]).default("manual"),
  /** Which commit tasks start from: the immutable baseline tag (eval) or main (interactive). */
  repoRef: z.enum(["baseline", "main"]).default("main"),
  startedAtMs: z.number(),
  deadlineMs: z.number(),

  spentUsd: z.number().default(0),
  unknownCostSteps: z.number().int().default(0),

  repo: TargetRepoSchema.nullable().default(null),
  worktree: WorktreeSchema.nullable().default(null),
  /** The worktree is clean at this commit after every completed node. */
  headCommit: z.string().nullable().default(null),
  conventions: z.string().default(""),

  planResult: PlannerOutputSchema.nullable().default(null),
  /** Raw spec JSON as the Planner returned it (validated in spec_draft). */
  specRaw: z.unknown().default(null),
  /** Current validated spec (null until a draft passes the schema). */
  spec: PersistedSpecChangeSchema.nullable().default(null),
  /** Rendered OpenSpec files (repo-relative path → content), as committed. */
  specFiles: z.record(z.string(), z.string()).default({}),
  specValid: z.boolean().default(false),
  specIssues: z.array(OpenSpecIssueSchema).default([]),
  specAttempts: z.number().int().default(0),
  /** Commit containing the validated spec; base of the developer's diff and scope. */
  specCommit: z.string().nullable().default(null),
  specDecision: z.enum(["approve", "reject"]).nullable().default(null),
  /** Human rejection comments, oldest first (fed back to the Planner). */
  specRejections: z.array(z.string()).default([]),

  /**
   * Index of the latest developer run: -1 before the first, 0 = first implementation.
   * Always equals gateFixCycles + reviewCycles once the developer ran; names logs and steps.
   */
  cycle: z.number().int().default(-1),
  /** Developer re-runs caused by a failed quality gate (limit: budget.max_gate_fix_cycles). */
  gateFixCycles: z.number().int().default(0),
  /** Developer re-runs caused by reviewer request_changes (limit: budget.max_review_cycles). */
  reviewCycles: z.number().int().default(0),
  /** Every rework started, in order, with its reason. */
  reworks: z.array(ReworkSchema).default([]),
  gateResult: GateResultSchema.nullable().default(null),
  reviewVerdict: ReviewVerdictSchema.nullable().default(null),

  /** Node that produced the latest update; drives routing. */
  lastNode: z.string().default(""),
  lastError: StepErrorSchema.nullable().default(null),
  status: z.enum(RUN_STATUSES).nullable().default(null),
  statusMessage: z.string().default(""),

  mergeDecision: z.enum(["merge", "close"]).nullable().default(null),
  mergeComment: z.string().nullable().default(null),
  mergeOutcome: MergeOutcomeSchema.nullable().default(null),

  steps: new ReducedValue(
    z.array(StepResultSchema).default(() => []),
    {
      inputSchema: z.array(StepResultSchema),
      reducer: (current: StepResult[], next: StepResult[]) => current.concat(next),
    },
  ),
});

export type RunStateValue = typeof RunState.State;
export type RunStateUpdate = typeof RunState.Update;
