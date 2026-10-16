import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { RunTaskResult } from "../pipeline/run-task.js";
import { RUN_STATUSES, type RunReport, type RunStatus } from "../schemas/report.js";
import { EXPECTED_OUTCOMES, type EvalMeta, type TaskSpec } from "../schemas/task.js";
import { findHiddenArtifacts } from "./hidden-guard.js";
import type { HiddenTestResult } from "./hidden-tests.js";
import { renderEvalSummaryMarkdown } from "./summary-markdown.js";

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
  reachedDeveloper: z.boolean(),
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
});
export type EvalTaskResult = z.infer<typeof EvalTaskResultSchema>;

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
  /** Mean fix cycles over tasks that reached the developer. */
  avgFixCycles: z.number().nullable(),
  avgDurationSec: z.number(),
  totalCostUsd: z.number(),
  unknownCostSteps: z.number().int(),
  byOutcome: z.record(z.string(), z.number().int()),
  hiddenLeaks: z.number().int(),
  /** Tasks left out of every metric above because the provider was unavailable. */
  excludedInfra: z.number().int().default(0),
});
export type EvalMetrics = z.infer<typeof EvalMetricsSchema>;

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
  /** Factory git commit that ran this pass (`-dirty` with uncommitted changes); null before it was recorded. */
  factoryCommit: z.string().nullable().default(null),
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
  const byOutcome: Record<string, number> = {};
  for (const r of results) byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
  return {
    total,
    correct,
    verifiedRate: total ? round(correct / total, 4) : 0,
    successClaims,
    falseSuccess,
    falseSuccessRate: successClaims ? round(falseSuccess / successClaims, 4) : null,
    avgFixCycles: dev.length
      ? round(dev.reduce((s, r) => s + r.fixCycles, 0) / dev.length, 2)
      : null,
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

export interface EvalTaskInput {
  task: TaskSpec;
  meta: EvalMeta;
}

export interface RunEvalDeps {
  /** Write this pass into `evalDir` with this id instead of a new runs/eval-<ts>/ (repeats). */
  evalId?: string;
  evalDir?: string;
  /** Runs one task through the pipeline, writing its run under `runsDir`. */
  runTask: (task: TaskSpec, runsDir: string) => Promise<RunTaskResult>;
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

  const results: EvalTaskResult[] = [];
  const kept = new Map(
    (prev?.tasks ?? []).filter((t) => t.outcome !== "infra_error").map((t) => [t.taskId, t]),
  );
  // Attempts that hit the provider limit before are replaced; their spend is still counted.
  const replacedCostUsd =
    (prev?.replacedCostUsd ?? 0) +
    (prev?.tasks ?? [])
      .filter((t) => t.outcome === "infra_error")
      .reduce((s, t) => s + t.costUsd, 0);
  const cap = { capUsd: deps.costCapUsd, reached: false, skippedTasks: [] as string[] };
  let interrupted: EvalSummary["interrupted"] = null;
  const summarize = () =>
    buildSummary(evalId, started, now(), deps, results, cap, {
      interrupted,
      replacedCostUsd,
      factoryCommit,
    });
  for (const [i, { task, meta }] of tasks.entries()) {
    const done = kept.get(task.id);
    if (done) {
      results.push(done);
      log(
        `\n[${i + 1}/${tasks.length}] ${task.id}: kept from the interrupted pass (${done.outcome})`,
      );
      continue;
    }
    const spent = results.reduce((sum, r) => sum + r.costUsd, 0) + replacedCostUsd;
    if (cap.capUsd !== undefined && spent >= cap.capUsd) {
      cap.reached = true;
      cap.skippedTasks = tasks.slice(i).map((t) => t.task.id);
      log(
        `\nEval cost cap $${cap.capUsd} reached ($${spent.toFixed(3)} spent): skipping ${cap.skippedTasks.length} task(s)`,
      );
      break;
    }
    log(
      `\n[${i + 1}/${tasks.length}] ${task.id} (${meta.difficulty}, expected: ${meta.expected_outcome})`,
    );
    const taskStarted = now();
    let report: RunReport | null = null;
    let reportPath: string | null = null;
    let crash: string | null = null;
    try {
      const res = await deps.runTask(task, evalDir);
      report = res.report;
      reportPath = path.relative(evalDir, res.reportMdPath);
    } catch (err) {
      crash = err instanceof Error ? err.message : String(err);
    }

    const status: RunStatus = report?.status ?? "error";
    let hidden: HiddenTestResult | null = null;
    let leaks: string[] = [];
    if (report?.worktree) {
      if (status === "success") {
        log("  running hidden tests…");
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
    const result = EvalTaskResultSchema.parse({
      taskId: task.id,
      title: task.title,
      difficulty: meta.difficulty,
      expected: meta.expected_outcome,
      status,
      outcome,
      correct,
      message: crash ? `pipeline crashed: ${crash}` : (report?.message ?? ""),
      fixCycles: report?.fixCycles ?? 0,
      reachedDeveloper:
        report?.steps.some((s) => s.kind === "agent" && s.role === "developer") ?? false,
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
      reportPath,
    });
    results.push(result);
    log(
      `  → ${outcome}${correct ? " ✓" : " ✗"}` +
        (hidden
          ? ` (hidden ${hidden.total === null ? "?" : hidden.total - (hidden.failed ?? 0)}/${hidden.total ?? "?"})`
          : "") +
        `, $${result.costUsd.toFixed(3)}, ${Math.round(result.durationMs / 1000)}s`,
    );
    if (outcome === "infra_error") {
      // Every later task would fail the same way: stop and leave the pass resumable.
      interrupted = {
        reason: result.message,
        pendingTasks: tasks.slice(i).map((t) => t.task.id),
      };
      log(
        `\nProvider unavailable — pass stopped; ${interrupted.pendingTasks.length} task(s) pending. ` +
          `Resume later with: npm run eval -- --resume <evalId>`,
      );
      await writeSummary(evalDir, summarize());
      break;
    }
    // Write progress after every task so a long eval leaves partial results.
    await writeSummary(evalDir, summarize());
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
  extra: Pick<EvalSummary, "interrupted" | "replacedCostUsd" | "factoryCommit">,
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
