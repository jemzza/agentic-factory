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
import type { TargetRepo } from "../git/target-repo.js";
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
import { renderReportMarkdown } from "../report/markdown.js";
import { DEVELOPER_DEFAULT_TOOLS, READ_ONLY_TOOLS } from "../runtimes/tool-policy.js";
import type { AgentRole, AgentRunResult, AgentRuntime } from "../runtimes/types.js";
import type { TargetConfig } from "../schemas/config.js";
import { RunReportSchema, type RunReport, type StepResult } from "../schemas/report.js";
import type { Store } from "../store/store.js";
import { decide } from "./decide.js";
import type { NodeName, RunStateUpdate, RunStateValue, StepError } from "./state.js";

/** Everything nodes need that is not state: services, paths, clock. Never checkpointed. */
export interface NodeContext {
  config: ResolvedConfig;
  runtime: AgentRuntime;
  store?: Store | undefined;
  runDir: string;
  ensureRepo: (target: TargetConfig, workdir: string) => Promise<TargetRepo>;
  makeSandboxExec: (repoDir: string) => Promise<SandboxExec>;
  now: () => Date;
  log: (message: string) => void;
  /** Set by the report node; read by the driver. */
  result?: { report: RunReport; reportJsonPath: string; reportMdPath: string };
}

export type NodeFn = (state: RunStateValue) => Promise<RunStateUpdate>;

const roundUsd = (n: number) => Math.round(n * 1e4) / 1e4;
const logsDir = (ctx: NodeContext) => path.join(ctx.runDir, "logs");
const checksDir = (ctx: NodeContext) => path.join(ctx.runDir, "checks");

function requireWorktree(s: RunStateValue): Worktree {
  if (!s.worktree) throw new Error("worktree not prepared");
  return s.worktree;
}

/**
 * Wraps a node: tags its update with `lastNode` and turns unexpected exceptions into a
 * `lastError` so the routing function can stop the run with a status instead of crashing.
 */
function node(name: NodeName, body: (s: RunStateValue) => Promise<RunStateUpdate>): NodeFn {
  return async (s) => {
    try {
      return { ...(await body(s)), lastNode: name };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const kind: StepError["kind"] = err instanceof SandboxInfraError ? "sandbox" : "exception";
      return { lastNode: name, lastError: { node: name, kind, message } };
    }
  };
}

/** Runs one agent call with the remaining budget and time; records it in state and the DB. */
async function agentStep(
  ctx: NodeContext,
  s: RunStateValue,
  role: AgentRole,
  cycle: number,
  prompt: string,
  outputSchema?: Record<string, unknown>,
): Promise<{ res: AgentRunResult; update: RunStateUpdate }> {
  const wt = requireWorktree(s);
  const { config, runtime, store } = ctx;
  const timeLeft = s.deadlineMs - ctx.now().getTime();
  const timeoutMs = Math.max(1, Math.min(config.stepTimeoutsMinutes[role] * 60_000, timeLeft));
  const remainingCost = s.task.budget.max_cost_usd - s.spentUsd;
  const seq = s.steps.filter((st) => st.kind === "agent").length + 1;
  const startedAt = ctx.now();
  ctx.log(`→ ${role}${cycle ? ` (fix cycle ${cycle})` : ""}…`);
  const dbStep = store?.startStep(s.runId, role, cycle, {
    runtime: runtime.name,
    model: config.models[role],
  });
  const res = await runtime.run({
    role,
    prompt,
    cwd: wt.path,
    allowedTools: role === "developer" ? DEVELOPER_DEFAULT_TOOLS : [...READ_ONLY_TOOLS],
    timeoutMs,
    systemPrompt: await buildSystemPrompt(role, s.conventions),
    maxBudgetUsd: Math.max(0.01, roundUsd(remainingCost)),
    model: config.models[role],
    logPath: path.join(logsDir(ctx), `${String(seq).padStart(2, "0")}-${role}-c${cycle}.jsonl`),
    ...(outputSchema ? { outputSchema } : {}),
  });
  const spentUsd = s.spentUsd + (res.costUsd ?? 0);
  const unknownCostSteps = s.unknownCostSteps + (res.costUsd === undefined ? 1 : 0);
  const step: StepResult = {
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
    rawLogPath: path.relative(ctx.runDir, res.rawLogPath),
    output: res.output,
    error: res.error ?? null,
  };
  if (dbStep && store) {
    store.finishStep(dbStep.id, {
      status: res.ok ? "ok" : "failed",
      costUsd: res.costUsd ?? null,
      logPath: res.rawLogPath,
      error: res.error ?? null,
    });
    store.updateRun(s.runId, { costUsd: roundUsd(spentUsd), unknownCostSteps });
  }
  ctx.log(
    `  ${role}: ${res.ok ? "ok" : `failed (${res.error?.kind ?? "?"})`}, $${(res.costUsd ?? 0).toFixed(3)}, ${Math.round(res.durationMs / 1000)}s`,
  );
  const update: RunStateUpdate = { spentUsd, unknownCostSteps, steps: [step] };
  if (!res.ok) {
    update.lastError = {
      node: role === "planner" ? "plan" : role === "developer" ? "develop" : "review",
      kind: res.error?.kind ?? "process",
      message: res.error?.message ?? "agent run failed",
    };
  }
  return { res, update };
}

function fixFeedback(s: RunStateValue, cycle: number): FixFeedback | undefined {
  if (cycle === 0 || !s.gateResult) return undefined;
  const review = s.gateResult.passed ? s.reviewVerdict : null;
  return {
    cycle,
    maxCycles: s.task.budget.max_fix_cycles,
    gateFailures: s.gateResult.passed ? "" : describeGateFailures(s.gateResult),
    reviewIssues: review ? review.issues : [],
    unmetCriteria: review
      ? review.criteria_check
          .filter((c) => !c.met)
          .map((c) => ({ criterion: c.criterion, evidence: c.evidence }))
      : [],
  };
}

async function assertNoHiddenArtifacts(dir: string): Promise<void> {
  const leaked = await findHiddenArtifacts(dir);
  if (leaked.length > 0)
    throw new Error(`hidden eval artifacts found in worktree: ${leaked.join(", ")}`);
}

/** Node implementations. Each calls existing modules; the graph only wires them together. */
export function makeNodes(ctx: NodeContext): Record<NodeName, NodeFn> {
  const { config } = ctx;
  let execCache: { repoDir: string; exec: Promise<SandboxExec> } | null = null;
  const execFor = (repoDir: string) => {
    if (execCache?.repoDir !== repoDir) execCache = { repoDir, exec: ctx.makeSandboxExec(repoDir) };
    return execCache.exec;
  };

  return {
    prepare: node("prepare", async (s) => {
      await mkdir(logsDir(ctx), { recursive: true });
      const repo = await ctx.ensureRepo(config.target, config.workdirAbs);
      const wt = await createWorktree({
        repoDir: repo.dir,
        baseCommit: repo.baseCommit,
        worktreesDir: path.join(config.workdirAbs, "worktrees"),
        taskId: s.task.id,
        runId: s.runId,
      });
      ctx.log(`worktree: ${wt.path} (${wt.branch})`);
      await assertNoHiddenArtifacts(wt.path);
      await execFor(repo.dir); // build/verify the sandbox image up front
      const conventions = await readFile(
        path.join(wt.path, config.target.conventionsFile),
        "utf8",
      ).catch(() => "(The repository has no conventions file.)");
      ctx.store?.updateRun(s.runId, {
        worktreePath: wt.path,
        branch: wt.branch,
        baseCommit: wt.baseCommit,
        headCommit: wt.baseCommit,
      });
      return { repo, worktree: wt, headCommit: wt.baseCommit, conventions };
    }),

    plan: node("plan", async (s) => {
      const { res, update } = await agentStep(
        ctx,
        s,
        "planner",
        0,
        plannerPrompt(s.task),
        PLANNER_OUTPUT_SCHEMA,
      );
      if (update.lastError) return update;
      const planned = parsePlannerResult(res);
      if (!planned.ok) return { ...update, lastError: { node: "plan", ...planned.error } };
      return { ...update, planResult: planned.value };
    }),

    // Phase 2 stubs: OpenSpec drafting and the approval interrupt arrive in Phases 4–5.
    spec_draft: node("spec_draft", () => Promise.resolve({})),
    spec_approval: node("spec_approval", () => Promise.resolve({})),

    develop: node("develop", async (s) => {
      if (!s.planResult) throw new Error("develop without a plan");
      const wt = requireWorktree(s);
      const cycle = s.cycle + 1;
      const { update } = await agentStep(
        ctx,
        s,
        "developer",
        cycle,
        developerPrompt(s.task, s.planResult, fixFeedback(s, cycle)),
      );
      if (update.lastError) return { ...update, cycle, reviewVerdict: null };
      const commit = await snapshot(wt, `factory: ${s.task.id} developer cycle ${cycle}`);
      await assertNoHiddenArtifacts(wt.path);
      const steps: StepResult[] = [
        ...(update.steps as StepResult[]),
        { kind: "snapshot", cycle, commit, message: `developer cycle ${cycle}` },
      ];
      ctx.store?.updateRun(s.runId, { headCommit: commit, fixCycles: cycle });
      return { ...update, steps, cycle, headCommit: commit, reviewVerdict: null };
    }),

    gate: node("gate", async (s) => {
      const wt = requireWorktree(s);
      if (!s.repo) throw new Error("gate without a target repo");
      const exec = await execFor(s.repo.dir);
      const started = ctx.now();
      ctx.log("→ quality gate…");
      const dbStep = ctx.store?.startStep(s.runId, "gate", s.cycle);
      const gate = await runGate({
        worktreePath: wt.path,
        changedFiles: (await changedFiles(wt)).map((f) => f.path),
        allowedPaths: s.task.scope.allowed_paths,
        checks: config.target.checks,
        checkTimeoutMs: Math.max(
          1,
          Math.min(config.stepTimeoutsMinutes.check * 60_000, s.deadlineMs - started.getTime()),
        ),
        exec,
        logDir: checksDir(ctx),
        logPrefix: `c${s.cycle}`,
      });
      if (dbStep) {
        ctx.store?.finishStep(dbStep.id, {
          status: gate.passed ? "ok" : "failed",
          logPath: checksDir(ctx),
          error: gate.passed ? null : { kind: "gate_failed", message: describeGateFailures(gate) },
        });
      }
      ctx.log(
        `  gate: ${gate.passed ? "passed" : "FAILED"} (scope ${gate.scope.passed ? "ok" : "fail"}; ${gate.checks
          .map(
            (c) =>
              `${c.name}=${c.passed ? "ok" : c.timedOut ? "timeout" : `exit ${c.exitCode ?? "?"}`}`,
          )
          .join(", ")})`,
      );
      const step: StepResult = {
        kind: "gate",
        cycle: s.cycle,
        startedAt: started.toISOString(),
        durationMs: ctx.now().getTime() - started.getTime(),
        result: gate,
      };
      return { gateResult: gate, steps: [step] };
    }),

    review: node("review", async (s) => {
      const wt = requireWorktree(s);
      const diff = await diffFromBase(wt);
      const { res, update } = await agentStep(
        ctx,
        s,
        "reviewer",
        s.cycle,
        reviewerPrompt(s.task, diff, config.maxDiffCharsForReview),
        REVIEWER_OUTPUT_SCHEMA,
      );
      if (update.lastError) return update;
      const reviewed = parseReviewerResult(res, s.task);
      if (!reviewed.ok) return { ...update, lastError: { node: "review", ...reviewed.error } };
      ctx.log(
        `  review: ${reviewed.value.verdict}${isApproved(reviewed.value) ? "" : " (not accepted)"}`,
      );
      return { ...update, reviewVerdict: reviewed.value };
    }),

    report: node("report", async (s) => {
      const decision = decide(s, ctx.now().getTime());
      const status = decision.kind === "stop" ? decision.status : "error";
      let message =
        decision.kind === "stop"
          ? decision.message
          : `internal error: report reached while the next node is ${decision.node}`;

      let diff = "";
      let files: string[] = [];
      let head: string | null = null;
      if (s.worktree) {
        try {
          head = await headCommit(s.worktree);
          diff = await diffFromBase(s.worktree);
          files = (await changedFiles(s.worktree)).map((f) => f.path);
        } catch (err) {
          message += ` (failed to read final diff: ${err instanceof Error ? err.message : String(err)})`;
        }
      }
      const finished = ctx.now();
      const report = RunReportSchema.parse({
        schemaVersion: 1,
        runId: s.runId,
        status,
        message,
        startedAt: new Date(s.startedAtMs).toISOString(),
        finishedAt: finished.toISOString(),
        durationMs: finished.getTime() - s.startedAtMs,
        task: s.task,
        runtime: ctx.runtime.name,
        models: { ...config.models },
        target: s.repo
          ? { name: config.target.name, repoDir: s.repo.dir, baseCommit: s.repo.baseCommit }
          : null,
        worktree: s.worktree
          ? { path: s.worktree.path, branch: s.worktree.branch, headCommit: head }
          : null,
        plan: s.planResult,
        fixCycles: Math.max(0, s.cycle),
        steps: s.steps,
        review: s.reviewVerdict,
        gate: s.gateResult,
        cost: {
          totalUsd: roundUsd(s.spentUsd),
          budgetUsd: s.task.budget.max_cost_usd,
          unknownCostSteps: s.unknownCostSteps,
        },
        changedFiles: files,
        diff,
      });
      await mkdir(ctx.runDir, { recursive: true });
      const reportJsonPath = path.join(ctx.runDir, "report.json");
      const reportMdPath = path.join(ctx.runDir, "report.md");
      await writeFile(reportJsonPath, JSON.stringify(report, null, 2));
      await writeFile(reportMdPath, renderReportMarkdown(report));
      if (ctx.store) {
        // A step still `running` here was cut short by an unexpected error.
        ctx.store.abandonRunningSteps(s.runId);
        ctx.store.updateRun(s.runId, {
          status,
          statusMessage: message,
          finishedAt: finished.toISOString(),
          costUsd: report.cost.totalUsd,
          unknownCostSteps: s.unknownCostSteps,
          fixCycles: report.fixCycles,
          ...(s.worktree ? { headCommit: head } : {}),
          reportPath: reportMdPath,
        });
      }
      ctx.result = { report, reportJsonPath, reportMdPath };
      return { status, statusMessage: message };
    }),
  };
}
