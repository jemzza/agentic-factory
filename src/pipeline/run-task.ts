import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { developerPrompt, type FixFeedback } from "../agents/developer.js";
import { parsePlannerResult, PLANNER_OUTPUT_SCHEMA, plannerPrompt } from "../agents/planner.js";
import { buildSystemPrompt } from "../agents/prompts.js";
import {
  isApproved,
  parseReviewerResult,
  REVIEWER_OUTPUT_SCHEMA,
  reviewerPrompt,
} from "../agents/reviewer.js";
import type { ResolvedConfig } from "../config/load-config.js";
import { findHiddenArtifacts } from "../eval/hidden-guard.js";
import { ensureTargetRepo, type TargetRepo } from "../git/target-repo.js";
import {
  changedFiles,
  createWorktree,
  diffFromBase,
  headCommit,
  snapshot,
  type Worktree,
} from "../git/worktree.js";
import {
  describeGateFailures,
  runGate,
  SandboxInfraError,
  type SandboxExec,
} from "../quality/gate.js";
import { ensureSandboxImage, runInSandbox } from "../quality/sandbox.js";
import { renderReportMarkdown } from "../report/markdown.js";
import { DEVELOPER_DEFAULT_TOOLS, READ_ONLY_TOOLS } from "../runtimes/tool-policy.js";
import type { AgentRole, AgentRunResult, AgentRuntime } from "../runtimes/types.js";
import type { PlannerOutput, ReviewVerdict } from "../schemas/agents.js";
import type { TargetConfig } from "../schemas/config.js";
import {
  RunReportSchema,
  type GateResult,
  type RunReport,
  type RunStatus,
  type StepResult,
} from "../schemas/report.js";
import type { TaskSpec } from "../schemas/task.js";

export interface RunTaskDeps {
  config: ResolvedConfig;
  runtime: AgentRuntime;
  /** Directory for run outputs (`runs/`). */
  runsDir: string;
  /** Returns a sandbox executor for the target repo. Default: Docker sandbox. */
  makeSandboxExec?: (repoDir: string) => Promise<SandboxExec>;
  /** Materializes the target repo. Default: ensureTargetRepo. */
  ensureRepo?: (target: TargetConfig, workdir: string) => Promise<TargetRepo>;
  now?: () => Date;
  /** Progress messages for the CLI. */
  log?: (message: string) => void;
}

export interface RunTaskResult {
  report: RunReport;
  reportJsonPath: string;
  reportMdPath: string;
}

/** Thrown inside the pipeline to stop with a final status. */
class StopRun extends Error {
  constructor(
    readonly status: RunStatus,
    message: string,
  ) {
    super(message);
  }
}

export function makeRunId(now: Date): string {
  const ts = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${ts}-${randomBytes(2).toString("hex")}`;
}

export const defaultSandboxExec = async (repoDir: string): Promise<SandboxExec> => {
  const image = await ensureSandboxImage(repoDir);
  return (worktreePath, command, timeoutMs) =>
    runInSandbox(worktreePath, command, timeoutMs, { image });
};

const MIN_STEP_MS = 1_000;
const roundUsd = (n: number) => Math.round(n * 1e4) / 1e4;

/**
 * Runs one task: Planner → Developer → Quality Gate → Reviewer, with up to
 * `max_fix_cycles` fix cycles. Never throws for agent/check failures: every outcome
 * ends in a report with a status. Success is decided only by external facts — gate
 * exit codes and the reviewer's structured verdict — never by the developer's message.
 */
export async function runTask(
  task: TaskSpec,
  deps: RunTaskDeps,
  opts: { runId?: string } = {},
): Promise<RunTaskResult> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  const { config, runtime } = deps;
  const started = now();
  const runId = opts.runId ?? makeRunId(started);
  const runDir = path.join(deps.runsDir, runId);
  const logsDir = path.join(runDir, "logs");
  const checksDir = path.join(runDir, "checks");
  await mkdir(logsDir, { recursive: true });

  const deadline = started.getTime() + task.budget.timeout_minutes * 60_000;
  const budget = task.budget.max_cost_usd;
  const steps: StepResult[] = [];
  let spent = 0;
  let unknownCostSteps = 0;
  let agentSeq = 0;
  let target: RunReport["target"] = null;
  let wt: Worktree | null = null;
  let plan: PlannerOutput | null = null;
  let review: ReviewVerdict | null = null;
  let gate: GateResult | null = null;
  let fixCycles = 0;
  let status: RunStatus;
  let message: string;

  const remainingMs = () => deadline - now().getTime();

  async function callAgent(
    role: AgentRole,
    cycle: number,
    prompt: string,
    systemPrompt: string,
    outputSchema?: Record<string, unknown>,
  ): Promise<AgentRunResult> {
    if (!wt) throw new Error("worktree not ready");
    const remainingCost = budget - spent;
    if (remainingCost <= 0) {
      throw new StopRun(
        "budget_exceeded",
        `budget $${budget} spent before ${role} (cycle ${cycle})`,
      );
    }
    const timeLeft = remainingMs();
    if (timeLeft < MIN_STEP_MS) {
      throw new StopRun(
        "timeout",
        `task timeout (${task.budget.timeout_minutes} min) reached before ${role}`,
      );
    }
    const timeoutMs = Math.min(config.stepTimeoutsMinutes[role] * 60_000, timeLeft);
    const startedAt = now();
    log(`→ ${role}${cycle ? ` (fix cycle ${cycle})` : ""}…`);
    const res = await runtime.run({
      role,
      prompt,
      cwd: wt.path,
      allowedTools: role === "developer" ? DEVELOPER_DEFAULT_TOOLS : [...READ_ONLY_TOOLS],
      timeoutMs,
      systemPrompt,
      maxBudgetUsd: Math.max(0.01, roundUsd(remainingCost)),
      model: config.models[role],
      logPath: path.join(logsDir, `${String(++agentSeq).padStart(2, "0")}-${role}-c${cycle}.jsonl`),
      ...(outputSchema ? { outputSchema } : {}),
    });
    if (res.costUsd === undefined) unknownCostSteps++;
    spent += res.costUsd ?? 0;
    steps.push({
      kind: "agent",
      role,
      cycle,
      ok: res.ok,
      startedAt: startedAt.toISOString(),
      durationMs: res.durationMs,
      costUsd: res.costUsd ?? null,
      tokens: res.tokens ?? null,
      numTurns: res.numTurns ?? null,
      permissionDenials: res.permissionDenials,
      rawLogPath: path.relative(runDir, res.rawLogPath),
      output: res.output,
      error: res.error ?? null,
    });
    log(
      `  ${role}: ${res.ok ? "ok" : `failed (${res.error?.kind ?? "?"})`}, $${(res.costUsd ?? 0).toFixed(3)}, ${Math.round(res.durationMs / 1000)}s`,
    );
    if (!res.ok) stopForAgentError(role, res.error);
    if (spent > budget) {
      throw new StopRun(
        "budget_exceeded",
        `spent $${spent.toFixed(4)} > budget $${budget} after ${role}`,
      );
    }
    return res;
  }

  function stopForAgentError(
    role: AgentRole,
    error: { kind: string; message: string } | undefined,
  ): never {
    const kind = error?.kind ?? "process";
    const detail = `${role}: ${error?.message ?? "unknown error"}`;
    if (kind === "timeout") throw new StopRun("timeout", detail);
    if (kind === "budget") throw new StopRun("budget_exceeded", detail);
    throw new StopRun("error", `${kind} error in ${detail}`);
  }

  try {
    // 1. Prepare: target repo, isolated worktree, sandbox, prompts.
    const ensureRepo = deps.ensureRepo ?? ensureTargetRepo;
    const repo = await ensureRepo(config.target, config.workdirAbs);
    target = { name: config.target.name, repoDir: repo.dir, baseCommit: repo.baseCommit };
    wt = await createWorktree({
      repoDir: repo.dir,
      baseCommit: repo.baseCommit,
      worktreesDir: path.join(config.workdirAbs, "worktrees"),
      taskId: task.id,
      runId,
    });
    log(`worktree: ${wt.path} (${wt.branch})`);
    const leaked = await findHiddenArtifacts(wt.path);
    if (leaked.length > 0) {
      throw new Error(`hidden eval artifacts found in worktree: ${leaked.join(", ")}`);
    }
    const exec = await (deps.makeSandboxExec ?? defaultSandboxExec)(repo.dir);
    const conventions = await readFile(
      path.join(wt.path, config.target.conventionsFile),
      "utf8",
    ).catch(() => "(The repository has no conventions file.)");
    const sys = {
      planner: await buildSystemPrompt("planner", conventions),
      developer: await buildSystemPrompt("developer", conventions),
      reviewer: await buildSystemPrompt("reviewer", conventions),
    };

    // 2. Planner.
    const plannerRes = await callAgent(
      "planner",
      0,
      plannerPrompt(task),
      sys.planner,
      PLANNER_OUTPUT_SCHEMA,
    );
    const planned = parsePlannerResult(plannerRes);
    if (!planned.ok) stopForAgentError("planner", planned.error);
    plan = planned.value;
    if (plan.questions.length > 0) {
      throw new StopRun(
        "needs_clarification",
        `planner asked ${plan.questions.length} question(s)`,
      );
    }

    // 3–6. Developer → snapshot → Gate → Reviewer, with fix cycles.
    let feedback: FixFeedback | undefined;
    for (let cycle = 0; ; cycle++) {
      review = null;
      await callAgent("developer", cycle, developerPrompt(task, plan, feedback), sys.developer);

      const commit = await snapshot(wt, `factory: ${task.id} developer cycle ${cycle}`);
      steps.push({ kind: "snapshot", cycle, commit, message: `developer cycle ${cycle}` });

      const leakedAfter = await findHiddenArtifacts(wt.path);
      if (leakedAfter.length > 0) {
        throw new Error(`hidden eval artifacts found in worktree: ${leakedAfter.join(", ")}`);
      }

      const timeLeft = remainingMs();
      if (timeLeft < MIN_STEP_MS)
        throw new StopRun("timeout", "task timeout reached before quality gate");
      const gateStarted = now();
      log("→ quality gate…");
      gate = await runGate({
        worktreePath: wt.path,
        changedFiles: (await changedFiles(wt)).map((f) => f.path),
        allowedPaths: task.scope.allowed_paths,
        checks: config.target.checks,
        checkTimeoutMs: Math.min(config.stepTimeoutsMinutes.check * 60_000, timeLeft),
        exec,
        logDir: checksDir,
        logPrefix: `c${cycle}`,
      });
      steps.push({
        kind: "gate",
        cycle,
        startedAt: gateStarted.toISOString(),
        durationMs: now().getTime() - gateStarted.getTime(),
        result: gate,
      });
      log(
        `  gate: ${gate.passed ? "passed" : "FAILED"} (scope ${gate.scope.passed ? "ok" : "fail"}; ${gate.checks
          .map(
            (c) =>
              `${c.name}=${c.passed ? "ok" : c.timedOut ? "timeout" : `exit ${c.exitCode ?? "?"}`}`,
          )
          .join(", ")})`,
      );

      if (gate.passed) {
        const diff = await diffFromBase(wt);
        const reviewRes = await callAgent(
          "reviewer",
          cycle,
          reviewerPrompt(task, diff, config.maxDiffCharsForReview),
          sys.reviewer,
          REVIEWER_OUTPUT_SCHEMA,
        );
        const reviewed = parseReviewerResult(reviewRes, task);
        if (!reviewed.ok) stopForAgentError("reviewer", reviewed.error);
        review = reviewed.value;
        log(`  review: ${review.verdict}${isApproved(review) ? "" : " (not accepted)"}`);
        if (isApproved(review)) {
          throw new StopRun(
            "success",
            `gate passed and reviewer approved after ${cycle} fix cycle(s)`,
          );
        }
      }

      if (cycle >= task.budget.max_fix_cycles) {
        throw gate.passed
          ? new StopRun("review_rejected", `reviewer did not approve after ${cycle} fix cycle(s)`)
          : new StopRun("gate_failed", `quality gate still failing after ${cycle} fix cycle(s)`);
      }
      fixCycles = cycle + 1;
      feedback = {
        cycle: cycle + 1,
        maxCycles: task.budget.max_fix_cycles,
        gateFailures: gate.passed ? "" : describeGateFailures(gate),
        reviewIssues: review ? review.issues : [],
        unmetCriteria: review
          ? review.criteria_check
              .filter((c) => !c.met)
              .map((c) => ({ criterion: c.criterion, evidence: c.evidence }))
          : [],
      };
    }
  } catch (err) {
    if (err instanceof StopRun) {
      status = err.status;
      message = err.message;
    } else {
      status = "error";
      message =
        err instanceof SandboxInfraError
          ? `sandbox failure: ${err.message}`
          : `unexpected error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // Report (always written).
  let diff = "";
  let files: string[] = [];
  let head: string | null = null;
  if (wt) {
    try {
      head = await headCommit(wt);
      diff = await diffFromBase(wt);
      files = (await changedFiles(wt)).map((f) => f.path);
    } catch (err) {
      message += ` (failed to read final diff: ${err instanceof Error ? err.message : String(err)})`;
    }
  }
  const finished = now();
  const report = RunReportSchema.parse({
    schemaVersion: 1,
    runId,
    status,
    message,
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: finished.getTime() - started.getTime(),
    task,
    runtime: runtime.name,
    models: { ...config.models },
    target,
    worktree: wt ? { path: wt.path, branch: wt.branch, headCommit: head } : null,
    plan,
    fixCycles,
    steps,
    review,
    gate,
    cost: { totalUsd: roundUsd(spent), budgetUsd: budget, unknownCostSteps },
    changedFiles: files,
    diff,
  });
  const reportJsonPath = path.join(runDir, "report.json");
  const reportMdPath = path.join(runDir, "report.md");
  await writeFile(reportJsonPath, JSON.stringify(report, null, 2));
  await writeFile(reportMdPath, renderReportMarkdown(report));
  return { report, reportJsonPath, reportMdPath };
}
