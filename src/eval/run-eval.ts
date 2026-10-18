import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { RunTaskResult } from "../pipeline/run-task.js";
import { RUN_STATUSES, type RunStatus } from "../schemas/report.js";
import { cycleLimits, EXPECTED_OUTCOMES, type EvalMeta, type TaskSpec } from "../schemas/task.js";
import { findHiddenArtifacts } from "./hidden-guard.js";
import type { HiddenTestResult } from "./hidden-tests.js";
import { renderEvalSummaryMarkdown } from "./summary-markdown.js";
import { CostPool } from "../pipeline/cost-pool.js";
import { makeRunId } from "../pipeline/run-task.js";

export const EVAL_OUTCOMES = [
  "verified",
  "false_success",
  "hidden_error",
  ...RUN_STATUSES.filter((s) => s !== "success"),
] as const;
export type EvalOutcome = (typeof EVAL_OUTCOMES)[number];

/**
 * Final eval outcome for one task.
 * - `success` is only a claim: hidden tests decide between `verified` and `false_success`
 *   (`hidden_error` if the hidden tests could not be run at all).
 * - Any other run status is the outcome as-is.
 * `correct` is true for `verified` on an implementable task and for `needs_clarification`
 * on a task whose expected outcome is a clarification (a contradictory request).
 */
export function classify(
  status: RunStatus,
  expected: EvalMeta["expected_outcome"],
  hidden: HiddenTestResult | null,
): { outcome: EvalOutcome; correct: boolean } {
  if (status === "success") {
    const outcome: EvalOutcome =
      hidden === null || hidden.infraError !== undefined
        ? "hidden_error"
        : hidden.passed
          ? "verified"
          : "false_success";
    return { outcome, correct: outcome === "verified" && expected === "implemented" };
  }
  return {
    outcome: status,
    correct: status === "needs_clarification" && expected === "needs_clarification",
  };
}

export const EvalTaskResultSchema = z.strictObject({
  taskId: z.string(),
  title: z.string(),
  difficulty: z.enum(["simple", "medium", "hard"]),
  expected: z.enum(EXPECTED_OUTCOMES),
  status: z.enum(RUN_STATUSES),
  outcome: z.enum(EVAL_OUTCOMES),
  correct: z.boolean(),
  message: z.string(),
  fixCycles: z.number().int().nonnegative(),
  /**
   * Split counters (null in results recorded before the split, or when unknown).
   * fixCycles stays their sum.
   */
  gateFixCycles: z.number().int().nonnegative().nullable().default(null),
  reviewCycles: z.number().int().nonnegative().nullable().default(null),
  /** The task's review budget, to tell whether a run used all of it. */
  maxReviewCycles: z.number().int().nonnegative().nullable().default(null),
  /** Human spec rejections; never counts against firstPass. */
  specRevisions: z.number().int().nonnegative().nullable().default(null),
  /** See firstPassOf(); null when not applicable (clarification task, infra_error). */
  firstPass: z.boolean().nullable().default(null),
  reachedDeveloper: z.boolean(),
  /** A reviewer ran at least once (default false in results recorded before the split). */
  reachedReview: z.boolean().default(false),
  durationMs: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  unknownCostSteps: z.number().int().nonnegative(),
  hidden: z
    .strictObject({
      passed: z.boolean(),
      exitCode: z.number().int().nullable(),
      timedOut: z.boolean(),
      total: z.number().int().nullable(),
      failed: z.number().int().nullable(),
      outputTail: z.string(),
      infraError: z.string().optional(),
    })
    .nullable(),
  /** Files from evals/hidden or evals/reference found in the agent's worktree (must be empty). */
  hiddenLeaks: z.array(z.string()),
  reportPath: z.string().nullable(),
  /**
   * Set only by `eval:rescore`: the outcome before rescoring and where the rescored tree came
   * from (`diff`: the stored final diff applied to the baseline; `commit`: the run's head
   * commit; `unavailable`: neither could be used, the outcome is `hidden_error`).
   */
  rescore: z
    .strictObject({
      previousOutcome: z.enum(EVAL_OUTCOMES),
      source: z.enum(["diff", "commit", "unavailable"]),
    })
    .optional(),
});
export type EvalTaskResult = z.infer<typeof EvalTaskResultSchema>;

/**
 * First pass: the task was implemented correctly (verified by hidden tests) with no rework of
 * either kind. Applies only to tasks whose correct outcome is an implementation, and never to
 * infra_error. Spec revisions do not matter. A result without split counters (recorded before
 * the split) is still decidable: fixCycles = 0 means both counters are 0.
 */
export function firstPassOf(
  r: Pick<EvalTaskResult, "expected" | "outcome" | "fixCycles" | "gateFixCycles" | "reviewCycles">,
): boolean | null {
  if (r.expected !== "implemented" || r.outcome === "infra_error") return null;
  if (r.outcome !== "verified") return false;
  if (r.gateFixCycles !== null && r.reviewCycles !== null) {
    return r.gateFixCycles === 0 && r.reviewCycles === 0;
  }
  return r.fixCycles === 0;
}

export const EvalMetricsSchema = z.strictObject({
  total: z.number().int(),
  correct: z.number().int(),
  /** correct / total: verified implementations + correct clarifications. */
  verifiedRate: z.number(),
  /** Tasks the system reported as `success`. */
  successClaims: z.number().int(),
  falseSuccess: z.number().int(),
  /** falseSuccess / successClaims (null if nothing was claimed): the honesty metric. */
  falseSuccessRate: z.number().nullable(),
  /** Verified with no rework / tasks whose correct outcome is an implementation (no infra). */
  firstPass: z.number().int().default(0),
  firstPassDenominator: z.number().int().default(0),
  firstPassRate: z.number().nullable().default(null),
  /** Tasks whose correct outcome is needs_clarification: outside the first-pass denominator. */
  clarificationTasks: z.number().int().default(0),
  clarificationCorrect: z.number().int().default(0),
  /** Mean fix cycles over tasks that reached the developer. */
  avgFixCycles: z.number().nullable(),
  /** Means of the split counters over tasks that reached the developer and have them. */
  avgGateFixCycles: z.number().nullable().default(null),
  avgReviewCycles: z.number().nullable().default(null),
  /** Tasks counted in the two means above (results without split counters are left out). */
  splitCyclesKnown: z.number().int().default(0),
  gateFailed: z.number().int().default(0),
  reviewRejected: z.number().int().default(0),
  /** Tasks that reached review. */
  reviewed: z.number().int().default(0),
  /** review_rejected / reviewed: runs stopped by the review limit. */
  reviewLimitStopRate: z.number().nullable().default(null),
  /** Tasks that used their whole review budget (reviewCycles = max_review_cycles > 0), any outcome. */
  reviewBudgetExhausted: z.number().int().default(0),
  avgDurationSec: z.number(),
  totalCostUsd: z.number(),
  unknownCostSteps: z.number().int(),
  byOutcome: z.record(z.string(), z.number().int()),
  hiddenLeaks: z.number().int(),
  /** Tasks left out of every metric above because the provider was unavailable. */
  excludedInfra: z.number().int().default(0),
});
export type EvalMetrics = z.infer<typeof EvalMetricsSchema>;

/**
 * Provenance of a rescored summary: the agents' results come from `sourceEvalId`; only the
 * hidden tests (at `hiddenTestsCommit`) were run again, on `baselineCommit` + each stored diff.
 * Time and cost are those of the source eval.
 */
export const RescoredFromSchema = z.strictObject({
  sourceEvalId: z.string(),
  baselineCommit: z.string(),
  hiddenTestsCommit: z.string().nullable(),
  rescoredAt: z.string(),
});
export type RescoredFrom = z.infer<typeof RescoredFromSchema>;

export const EvalSummarySchema = z.strictObject({
  schemaVersion: z.literal(1),
  evalId: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  models: z.record(z.string(), z.string()),
  runtime: z.string(),
  /**
   * Eval runs approve specs automatically (`approval: auto`); results with manual
   * approval are never mixed into an eval summary.
   */
  specApproval: z.literal("auto").default("auto"),
  metrics: EvalMetricsSchema,
  tasks: z.array(EvalTaskResultSchema),
  /** Global spend cap for this eval run; when reached, remaining tasks are skipped. */
  costCap: z
    .strictObject({
      capUsd: z.number().positive(),
      reached: z.boolean(),
      skippedTasks: z.array(z.string()),
    })
    .nullable(),
  /**
   * Set when the pass stopped because the provider was unavailable: the task that hit it
   * (kept in `tasks` as `infra_error`) and the tasks not started. Resume re-runs both.
   */
  interrupted: z
    .strictObject({ reason: z.string(), pendingTasks: z.array(z.string()) })
    .nullable()
    .default(null),
  /** Spent on attempts that ended in infra_error and were replaced by a resume. */
  replacedCostUsd: z.number().nonnegative().default(0),
  /** Tasks whose attempt ended in infra_error and was replaced by a resume (one per attempt). */
  replacedInfraTasks: z.array(z.string()).default([]),
  /**
   * Runs stopped at a node boundary when the pass stopped (another task hit infra_error, or the
   * cost cap): `--resume` continues each from its checkpoint instead of starting over.
   */
  pausedRuns: z
    .array(
      z.strictObject({
        taskId: z.string(),
        runId: z.string(),
        spentUsd: z.number().nonnegative(),
        reason: z.string(),
      }),
    )
    .default([]),
  /** Factory git commit that ran this pass (`-dirty` with uncommitted changes); null before it was recorded. */
  factoryCommit: z.string().nullable().default(null),
  /** Set when this summary was produced by `eval:rescore` (no agent calls) from another eval. */
  rescoredFrom: RescoredFromSchema.nullable().default(null),
});
export type EvalSummary = z.infer<typeof EvalSummarySchema>;

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;

/**
 * Metrics over the tasks the factory actually decided. `infra_error` (provider unavailable:
 * usage/rate limit, outage) says nothing about the factory, so it is excluded and counted
 * separately; such tasks are re-run by `npm run eval -- --resume`.
 */
export function computeMetrics(all: readonly EvalTaskResult[]): EvalMetrics {
  const results = all.filter((r) => r.outcome !== "infra_error");
  const total = results.length;
  const correct = results.filter((r) => r.correct).length;
  const successClaims = results.filter((r) => r.status === "success").length;
  const falseSuccess = results.filter((r) => r.outcome === "false_success").length;
  const dev = results.filter((r) => r.reachedDeveloper);
  const split = dev.filter((r) => r.gateFixCycles !== null && r.reviewCycles !== null);
  const mean = (xs: number[]) =>
    xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length, 2) : null;
  const firstPassFlags = results.map(firstPassOf).filter((f): f is boolean => f !== null);
  const firstPass = firstPassFlags.filter(Boolean).length;
  const clarification = results.filter((r) => r.expected === "needs_clarification");
  const reviewed = results.filter((r) => r.reachedReview).length;
  const reviewRejected = results.filter((r) => r.outcome === "review_rejected").length;
  const byOutcome: Record<string, number> = {};
  for (const r of results) byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
  return {
    total,
    correct,
    verifiedRate: total ? round(correct / total, 4) : 0,
    successClaims,
    falseSuccess,
    falseSuccessRate: successClaims ? round(falseSuccess / successClaims, 4) : null,
    firstPass,
    firstPassDenominator: firstPassFlags.length,
    firstPassRate: firstPassFlags.length ? round(firstPass / firstPassFlags.length, 4) : null,
    clarificationTasks: clarification.length,
    clarificationCorrect: clarification.filter((r) => r.correct).length,
    avgFixCycles: dev.length
      ? round(dev.reduce((s, r) => s + r.fixCycles, 0) / dev.length, 2)
      : null,
    avgGateFixCycles: mean(split.map((r) => r.gateFixCycles ?? 0)),
    avgReviewCycles: mean(split.map((r) => r.reviewCycles ?? 0)),
    splitCyclesKnown: split.length,
    gateFailed: results.filter((r) => r.outcome === "gate_failed").length,
    reviewRejected,
    reviewed,
    reviewLimitStopRate: reviewed ? round(reviewRejected / reviewed, 4) : null,
    reviewBudgetExhausted: results.filter(
      (r) =>
        r.maxReviewCycles !== null && r.maxReviewCycles > 0 && r.reviewCycles === r.maxReviewCycles,
    ).length,
    avgDurationSec: total
      ? round(results.reduce((s, r) => s + r.durationMs, 0) / total / 1000, 1)
      : 0,
    totalCostUsd: round(
      results.reduce((s, r) => s + r.costUsd, 0),
      4,
    ),
    unknownCostSteps: results.reduce((s, r) => s + r.unknownCostSteps, 0),
    byOutcome,
    hiddenLeaks: results.reduce((s, r) => s + r.hiddenLeaks.length, 0),
    excludedInfra: all.length - results.length,
  };
}

/** What a pass gives each run: when to stop, and the shared cost cap. */
export interface RunControl {
  runId: string;
  pauseReason: () => string | null;
  costPool: CostPool;
}

export type EvalRunOutcome =
  | { kind: "done"; result: RunTaskResult }
  | { kind: "paused"; runId: string; reason: string; spentUsd: number };

function isEvalRunOutcome(x: RunTaskResult | EvalRunOutcome): x is EvalRunOutcome {
  const kind = (x as { kind?: unknown }).kind;
  return kind === "paused" || kind === "done";
}

export interface PoolStatus {
  running: number;
  done: number;
  pending: number;
  spentUsd: number;
}

export interface EvalTaskInput {
  task: TaskSpec;
  meta: EvalMeta;
}

export interface RunEvalDeps {
  /** Write this pass into `evalDir` with this id instead of a new runs/eval-<ts>/ (repeats). */
  evalId?: string;
  evalDir?: string;
  /**
   * Runs one task through the pipeline, writing its run under `runsDir`. `ctl` lets the pass
   * stop it at a node boundary and share the cost cap; a stopped run comes back `paused`.
   */
  runTask: (
    task: TaskSpec,
    runsDir: string,
    ctl: RunControl,
  ) => Promise<RunTaskResult | EvalRunOutcome>;
  /** Continues a run paused by an earlier pass (from its checkpoint). */
  resumeTask?: (
    runId: string,
    runsDir: string,
    ctl: RunControl,
  ) => Promise<RunTaskResult | EvalRunOutcome>;
  /** Tasks run in parallel (default 1: one after another). */
  concurrency?: number;
  /** Pool status after every start and finish (parallel passes). */
  onStatus?: (status: PoolStatus) => void;
  /** Runs a task's hidden tests against a finished worktree (on a copy, in the sandbox). */
  runHidden: (worktreePath: string, taskId: string) => Promise<HiddenTestResult>;
  runsDir: string;
  runtimeName: string;
  /** Stop starting new tasks once the eval has spent this much (USD). */
  costCapUsd?: number;
  /** Factory git commit recorded in the summary. */
  factoryCommit?: string | null;
  /**
   * Resume: the pass's earlier summary. Its decided tasks are kept as they are; tasks that
   * ended in infra_error or never started are run.
   */
  previous?: EvalSummary;
  /**
   * Records the eval's first-pass decision for a finished run (database row, report files).
   * Called once per task the pipeline finished, after the hidden tests.
   */
  recordFirstPass?: (run: RunTaskResult, firstPass: boolean | null) => Promise<void>;
  models: Record<string, string>;
  now?: () => Date;
  log?: (message: string) => void;
}

export function makeEvalId(now: Date): string {
  return `eval-${now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;
}

/**
 * Runs the eval suite sequentially. A task that crashes the pipeline is recorded as
 * `error` and the suite continues. Writes `summary.json` and `summary.md`.
 */
export async function runEval(
  tasks: readonly EvalTaskInput[],
  deps: RunEvalDeps,
): Promise<{ summary: EvalSummary; summaryMdPath: string; summaryJsonPath: string }> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  const prev = deps.previous;
  const started = prev ? new Date(prev.startedAt) : now();
  const evalId = deps.evalId ?? makeEvalId(started);
  const evalDir = deps.evalDir ?? path.join(deps.runsDir, evalId);
  await mkdir(evalDir, { recursive: true });
  const factoryCommit = prev?.factoryCommit ?? deps.factoryCommit ?? null;

  const kept = new Map(
    (prev?.tasks ?? []).filter((t) => t.outcome !== "infra_error").map((t) => [t.taskId, t]),
  );
  // Attempts that hit the provider limit before are replaced; their spend is still counted.
  const replacedCostUsd =
    (prev?.replacedCostUsd ?? 0) +
    (prev?.tasks ?? [])
      .filter((t) => t.outcome === "infra_error")
      .reduce((s, t) => s + t.costUsd, 0);
  const replacedInfraTasks = [
    ...(prev?.replacedInfraTasks ?? []),
    ...(prev?.tasks ?? []).filter((t) => t.outcome === "infra_error").map((t) => t.taskId),
  ];
  const cap = { capUsd: deps.costCapUsd, reached: false, skippedTasks: [] as string[] };
  let interrupted: EvalSummary["interrupted"] = null;
  const paused: EvalSummary["pausedRuns"] = [];
  const pausedBefore = new Map((prev?.pausedRuns ?? []).map((p) => [p.taskId, p]));
  // The cap is shared by every run of this pass: kept results, replaced attempts and the
  // spend of runs paused earlier are already spent.
  const pool = new CostPool(
    deps.costCapUsd ?? null,
    [...kept.values()].reduce((sum, t) => sum + t.costUsd, 0) +
      replacedCostUsd +
      [...pausedBefore.values()].reduce((sum, p) => sum + p.spentUsd, 0),
  );
  // Why the pass stopped taking work (set by a worker; read by every run's pauseReason).
  const stop: { reason: string | null } = { reason: null };
  // Read through a function: workers set it while another one awaits.
  const stopped = (): string | null => stop.reason;
  const slots: (EvalTaskResult | null)[] = tasks.map(() => null);
  const results = (): EvalTaskResult[] => slots.filter((r): r is EvalTaskResult => r !== null);
  const summarize = () =>
    buildSummary(evalId, started, now(), deps, results(), cap, {
      interrupted,
      pausedRuns: paused,
      replacedCostUsd,
      replacedInfraTasks,
      factoryCommit,
    });
  const concurrency = Math.max(1, deps.concurrency ?? 1);
  let running = 0;
  let finished = 0;
  const status = () =>
    deps.onStatus?.({
      running,
      done: finished,
      pending: tasks.length - finished - running,
      spentUsd: pool.spentUsd(),
    });

  /** Hidden tests decide a success claim; every other status is the outcome as-is. */
  const judge = async (
    task: TaskSpec,
    meta: EvalMeta,
    run: RunTaskResult | null,
    crash: string | null,
    taskStarted: Date,
  ): Promise<EvalTaskResult> => {
    const report = run?.report ?? null;
    const status: RunStatus = report?.status ?? "error";
    let hidden: HiddenTestResult | null = null;
    let leaks: string[] = [];
    if (report?.worktree) {
      if (status === "success") {
        log(`  ${task.id}: running hidden tests…`);
        try {
          hidden = await deps.runHidden(report.worktree.path, task.id);
        } catch (err) {
          hidden = {
            passed: false,
            exitCode: null,
            timedOut: false,
            total: null,
            failed: null,
            durationMs: 0,
            outputTail: "",
            infraError: err instanceof Error ? err.message : String(err),
          };
        }
      }
      // The hidden tests ran on a copy; the agent's worktree must still be free of them.
      leaks = await findHiddenArtifacts(report.worktree.path);
    }
    const { outcome, correct } = classify(status, meta.expected_outcome, hidden);
    const agentRoles = new Set(
      (report?.steps ?? []).flatMap((st) => (st.kind === "agent" ? [st.role] : [])),
    );
    const limits = cycleLimits(task.budget);
    const counters = {
      fixCycles: report?.fixCycles ?? 0,
      gateFixCycles: report?.gateFixCycles ?? null,
      reviewCycles: report?.reviewCycles ?? null,
    };
    return EvalTaskResultSchema.parse({
      taskId: task.id,
      title: task.title,
      difficulty: meta.difficulty,
      expected: meta.expected_outcome,
      status,
      outcome,
      correct,
      message: crash ? `pipeline crashed: ${crash}` : (report?.message ?? ""),
      ...counters,
      maxReviewCycles: limits?.review ?? null,
      specRevisions: report?.specRevisions ?? null,
      firstPass: firstPassOf({ expected: meta.expected_outcome, outcome, ...counters }),
      reachedDeveloper: agentRoles.has("developer"),
      reachedReview: agentRoles.has("reviewer"),
      durationMs: report?.durationMs ?? now().getTime() - taskStarted.getTime(),
      costUsd: report?.cost.totalUsd ?? 0,
      unknownCostSteps: report?.cost.unknownCostSteps ?? 0,
      hidden: hidden && {
        passed: hidden.passed,
        exitCode: hidden.exitCode,
        timedOut: hidden.timedOut,
        total: hidden.total,
        failed: hidden.failed,
        outputTail: hidden.outputTail,
        ...(hidden.infraError !== undefined ? { infraError: hidden.infraError } : {}),
      },
      hiddenLeaks: leaks,
      reportPath: run ? path.relative(evalDir, run.reportMdPath) : null,
    });
  };

  const decide = async (i: number): Promise<void> => {
    const item = tasks[i];
    if (!item) return;
    const { task, meta } = item;
    const done = kept.get(task.id);
    if (done) {
      slots[i] = done;
      log(
        `\n[${i + 1}/${tasks.length}] ${task.id}: kept from the interrupted pass (${done.outcome})`,
      );
      return;
    }
    if (stop.reason !== null || pool.exhausted()) {
      if (stop.reason === null) cap.reached = true;
      cap.skippedTasks.push(task.id);
      return;
    }
    const before = pausedBefore.get(task.id);
    log(
      `\n[${i + 1}/${tasks.length}] ${task.id} (${meta.difficulty}, expected: ${meta.expected_outcome})${before ? " — resumed from its checkpoint" : ""}`,
    );
    const ctl: RunControl = {
      runId: before?.runId ?? makeRunId(now()),
      pauseReason: () => stop.reason,
      costPool: pool,
    };
    const taskStarted = now();
    let finishedRun: RunTaskResult | null = null;
    let crash: string | null = null;
    try {
      const raw =
        before && deps.resumeTask
          ? await deps.resumeTask(before.runId, evalDir, ctl)
          : await deps.runTask(task, evalDir, ctl);
      // Only "paused" and "done" are EvalRunOutcomes. Anything else is a finished run, even if
      // it carries another `kind` (RunOutcome's "finished"): reading it as an outcome crashed
      // every run that ended without the merge gate (needs_clarification, gate_failed, ...).
      const out: EvalRunOutcome = isEvalRunOutcome(raw) ? raw : { kind: "done", result: raw };
      if (out.kind === "paused") {
        pool.charge(out.spentUsd - pool.spentBy(ctl.runId) - (before?.spentUsd ?? 0), ctl.runId);
        paused.push({
          taskId: task.id,
          runId: out.runId,
          spentUsd: out.spentUsd,
          reason: out.reason,
        });
        if (out.reason.includes("cost cap")) cap.reached = true;
        log(`  ⏸ ${task.id} paused (${out.reason}); --resume continues it from its checkpoint`);
        return;
      }
      finishedRun = out.result;
      // Whatever the run spent outside the pool's reservations still counts against the cap.
      pool.charge(
        out.result.report.cost.totalUsd - pool.spentBy(ctl.runId) - (before?.spentUsd ?? 0),
        ctl.runId,
      );
    } catch (err) {
      crash = err instanceof Error ? err.message : String(err);
    }
    const result = await judge(task, meta, finishedRun, crash, taskStarted);
    slots[i] = result;
    if (finishedRun && deps.recordFirstPass)
      await deps.recordFirstPass(finishedRun, result.firstPass);
    log(
      `  → ${task.id}: ${result.outcome}${result.correct ? " ✓" : " ✗"}` +
        (result.hidden
          ? ` (hidden ${result.hidden.total === null ? "?" : result.hidden.total - (result.hidden.failed ?? 0)}/${result.hidden.total ?? "?"})`
          : "") +
        `, $${result.costUsd.toFixed(3)}, ${Math.round(result.durationMs / 1000)}s`,
    );
    if (result.outcome === "infra_error" && stopped() === null) {
      // Every later task would fail the same way: start nothing new, stop the running ones at
      // their next node boundary (checkpointed), and leave the pass resumable.
      stop.reason = `another task hit infra_error (${task.id})`;
      interrupted = { reason: result.message, pendingTasks: [] };
      log(
        `\nProvider unavailable — no new tasks; running ones pause at their next node. Resume later with: npm run eval -- --resume <evalId>`,
      );
    }
    // Write progress after every task so a long eval leaves partial results.
    await writeSummary(evalDir, summarize());
  };

  // A simple pool: `concurrency` workers take the next task index in order.
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      running++;
      status();
      try {
        await decide(i);
      } finally {
        running--;
        finished++;
        status();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));

  // Assigned inside the workers; TypeScript cannot see that through the closures.
  const stoppedBy = interrupted as EvalSummary["interrupted"];
  if (stoppedBy !== null) {
    const decided = new Set(results().map((r) => r.taskId));
    interrupted = {
      reason: stoppedBy.reason,
      pendingTasks: tasks
        .map((t) => t.task.id)
        .filter(
          (id) =>
            !decided.has(id) || results().find((r) => r.taskId === id)?.outcome === "infra_error",
        ),
    };
  }
  const summary = summarize();
  const paths = await writeSummary(evalDir, summary);
  return { summary, ...paths };
}

function buildSummary(
  evalId: string,
  started: Date,
  finished: Date,
  deps: RunEvalDeps,
  results: EvalTaskResult[],
  cap: { capUsd: number | undefined; reached: boolean; skippedTasks: string[] },
  extra: Pick<
    EvalSummary,
    "interrupted" | "pausedRuns" | "replacedCostUsd" | "replacedInfraTasks" | "factoryCommit"
  >,
): EvalSummary {
  return EvalSummarySchema.parse({
    schemaVersion: 1,
    evalId,
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    models: deps.models,
    runtime: deps.runtimeName,
    metrics: computeMetrics(results),
    tasks: results,
    costCap:
      cap.capUsd === undefined
        ? null
        : { capUsd: cap.capUsd, reached: cap.reached, skippedTasks: cap.skippedTasks },
    ...extra,
  });
}

async function writeSummary(
  evalDir: string,
  summary: EvalSummary,
): Promise<{ summaryMdPath: string; summaryJsonPath: string }> {
  const summaryJsonPath = path.join(evalDir, "summary.json");
  const summaryMdPath = path.join(evalDir, "summary.md");
  await writeFile(summaryJsonPath, JSON.stringify(summary, null, 2));
  await writeFile(summaryMdPath, renderEvalSummaryMarkdown(summary));
  return { summaryMdPath, summaryJsonPath };
}
