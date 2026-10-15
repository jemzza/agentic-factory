import { ReducedValue, StateSchema } from "@langchain/langgraph";
import { z } from "zod";
import { PlannerOutputSchema, ReviewVerdictSchema } from "../schemas/agents.js";
import {
  GateResultSchema,
  RUN_STATUSES,
  StepResultSchema,
  type StepResult,
} from "../schemas/report.js";
import { TaskSpecSchema } from "../schemas/task.js";

export const NODE_NAMES = [
  "prepare",
  "plan",
  "spec_draft",
  "spec_approval",
  "develop",
  "gate",
  "review",
  "report",
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
  task: TaskSpecSchema,
  /** Directory for this run's logs and reports (state, so a resumed process can find it). */
  runDir: z.string(),
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
  /** Index of the latest developer run: -1 before the first, 0 = first implementation. */
  cycle: z.number().int().default(-1),
  gateResult: GateResultSchema.nullable().default(null),
  reviewVerdict: ReviewVerdictSchema.nullable().default(null),

  /** Node that produced the latest update; drives routing. */
  lastNode: z.string().default(""),
  lastError: StepErrorSchema.nullable().default(null),
  status: z.enum(RUN_STATUSES).nullable().default(null),
  statusMessage: z.string().default(""),

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
