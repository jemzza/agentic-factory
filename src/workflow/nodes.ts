import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { developerPrompt, type FixFeedback } from "../agents/developer.js";
import {
  parsePlannerResult,
  parseSpecResult,
  PLANNER_OUTPUT_SCHEMA,
  plannerPrompt,
  SPEC_OUTPUT_SCHEMA,
  specFixPrompt,
} from "../agents/planner.js";
import { interrupt, isGraphBubbleUp } from "@langchain/langgraph";
import { changeDir, renderSpecFiles, validateChange, writeSpecFiles } from "../spec/openspec.js";
import { BASELINE_TAG, type RepoRef } from "../git/target-repo.js";
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
  filesAtCommit,
  headCommit,
  resetWorktree,
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
import {
  SpecApprovalAnswerSchema,
  type NodeName,
  type RunStateUpdate,
  type RunStateValue,
  type StepError,
} from "./state.js";

/** Everything nodes need that is not state: services, paths, clock. Never checkpointed. */
export interface NodeContext {
  config: ResolvedConfig;
  runtime: AgentRuntime;
  store?: Store | undefined;
  ensureRepo: (target: TargetConfig, workdir: string, from: RepoRef) => Promise<TargetRepo>;
  makeSandboxExec: (repoDir: string) => Promise<SandboxExec>;
  now: () => Date;
  /**
   * Clock for deadline math (ms): wall time minus time the run spent paused/crashed
   * between processes, so a resumed run is not timed out by its downtime.
   */
  deadlineNow: () => number;
  log: (message: string) => void;
  /** Set by the report node; read by the driver. */
  result?: { report: RunReport; reportJsonPath: string; reportMdPath: string };
}

export type NodeFn = (state: RunStateValue) => Promise<RunStateUpdate>;

const roundUsd = (n: number) => Math.round(n * 1e4) / 1e4;
const logsDir = (s: RunStateValue) => path.join(s.runDir, "logs");
const checksDir = (s: RunStateValue) => path.join(s.runDir, "checks");
const AGENT_STEP_NODES = new Set(["planner", "developer", "reviewer"]);

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
      // interrupt() and other LangGraph control flow must propagate untouched.
      if (isGraphBubbleUp(err)) throw err;
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
  /** Node to blame in `lastError` (defaults to the role's own node). */
  errorNode?: NodeName,
): Promise<{ res: AgentRunResult; update: RunStateUpdate }> {
  const wt = requireWorktree(s);
  const { config, runtime, store } = ctx;
  const timeLeft = s.deadlineMs - ctx.deadlineNow();
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
    logPath: path.join(logsDir(s), `${String(seq).padStart(2, "0")}-${role}-c${cycle}.jsonl`),
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
    rawLogPath: path.relative(s.runDir, res.rawLogPath),
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
      node:
        errorNode ?? (role === "planner" ? "plan" : role === "developer" ? "develop" : "review"),
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
  const worktreesRoot = path.join(config.workdirAbs, "worktrees");
  let execCache: { repoDir: string; exec: Promise<SandboxExec> } | null = null;
  const execFor = (repoDir: string) => {
    if (execCache?.repoDir !== repoDir) execCache = { repoDir, exec: ctx.makeSandboxExec(repoDir) };
    return execCache.exec;
  };

  /** The approved spec as committed (never read from the working tree). */
  const approvedSpec = async (s: RunStateValue): Promise<Record<string, string>> => {
    if (!s.specCommit || !s.worktree) return {};
    return filesAtCommit(s.worktree, s.specCommit, Object.keys(s.specFiles));
  };

  /** The approved spec files must be identical to the spec commit. */
  const specPolicyViolations = async (s: RunStateValue): Promise<string[]> => {
    if (!s.specCommit || !s.worktree) return [];
    const changed = await changedFiles(s.worktree, s.specCommit);
    return changed
      .filter((f) => f.path.startsWith(`${changeDir(s.task.id)}/`))
      .map(
        (f) =>
          `the approved specification file \`${f.path}\` was modified; revert it (the spec is read-only)`,
      );
  };

  return {
    prepare: node("prepare", async (s) => {
      await mkdir(logsDir(s), { recursive: true });
      const fullRepo = await ctx.ensureRepo(config.target, config.workdirAbs, s.repoRef);
      const repo = { dir: fullRepo.dir, baseCommit: fullRepo.baseCommit };
      if (fullRepo.baselineCreated && fullRepo.baselineCommit && ctx.store) {
        ctx.store.recordBaseline({
          target: config.target.name,
          tag: BASELINE_TAG,
          commitHash: fullRepo.baselineCommit,
          actor: "factory",
          reason: "initial materialization",
        });
      }
      const wt = await createWorktree({
        repoDir: repo.dir,
        baseCommit: repo.baseCommit,
        worktreesDir: worktreesRoot,
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
        plannerPrompt(s.task, s.specRejections),
        PLANNER_OUTPUT_SCHEMA,
      );
      if (update.lastError) return update;
      const planned = parsePlannerResult(res);
      if (!planned.ok) return { ...update, lastError: { node: "plan", ...planned.error } };
      // A new plan starts a fresh spec draft (rejection comments are kept).
      return {
        ...update,
        planResult: planned.value,
        spec: planned.value.spec ?? null,
        specFiles: {},
        specValid: false,
        specIssues: [],
        specAttempts: 0,
        specCommit: null,
        specDecision: null,
      };
    }),

    spec_draft: node("spec_draft", async (s) => {
      const wt = requireWorktree(s);
      const attempt = s.specAttempts + 1;
      let spec = s.spec;
      let update: RunStateUpdate = {};
      if (attempt > 1 && spec) {
        // Second and last attempt: the Planner fixes its spec using the validator's output.
        const fix = await agentStep(
          ctx,
          s,
          "planner",
          0,
          specFixPrompt(s.task, spec, s.specIssues),
          SPEC_OUTPUT_SCHEMA,
          "spec_draft",
        );
        update = fix.update;
        if (update.lastError) return { ...update, specAttempts: attempt };
        const parsed = parseSpecResult(fix.res);
        if (!parsed.ok) {
          return {
            ...update,
            specAttempts: attempt,
            lastError: { node: "spec_draft", ...parsed.error },
          };
        }
        spec = parsed.value;
      }
      if (!spec) throw new Error("spec_draft without a spec");

      // The spec is always the first change on the branch: start from the base commit.
      await resetWorktree(wt, wt.baseCommit, worktreesRoot);
      const files = renderSpecFiles(
        s.task.id,
        spec,
        new Date(s.startedAtMs).toISOString().slice(0, 10),
      );
      await writeSpecFiles(wt.path, s.task.id, files);
      const validation = await validateChange(wt.path, s.task.id);
      if (validation.kind === "error") throw new Error(`openspec validate: ${validation.message}`);
      const prevSteps = (update.steps as StepResult[] | undefined) ?? [];
      if (validation.kind === "invalid") {
        await resetWorktree(wt, wt.baseCommit, worktreesRoot);
        ctx.log(`  spec draft #${attempt}: invalid (${validation.issues.length} issue(s))`);
        return {
          ...update,
          spec,
          specFiles: files,
          specValid: false,
          specIssues: validation.issues,
          specAttempts: attempt,
          headCommit: wt.baseCommit,
          steps: [
            ...prevSteps,
            { kind: "spec", attempt, valid: false, issues: validation.issues, commit: null },
          ],
        };
      }
      const commit = await snapshot(
        wt,
        `factory: ${s.task.id} OpenSpec change (draft #${attempt})`,
      );
      ctx.log(`  spec draft #${attempt}: valid (${changeDir(s.task.id)})`);
      ctx.store?.updateRun(s.runId, { headCommit: commit });
      return {
        ...update,
        spec,
        specFiles: files,
        specValid: true,
        specIssues: validation.issues,
        specAttempts: attempt,
        specCommit: commit,
        headCommit: commit,
        steps: [
          ...prevSteps,
          { kind: "spec", attempt, valid: true, issues: validation.issues, commit },
        ],
      };
    }),

    // Pure apart from the auto-approval record: on resume LangGraph re-runs this node from
    // its start, and interrupt() then returns the human's answer.
    spec_approval: node("spec_approval", (s) => {
      if (s.specApprovalMode === "auto") {
        const already = ctx.store
          ?.listApprovals(s.runId)
          .some((a) => a.gate === "spec" && a.actor === "auto" && a.comment === s.specCommit);
        if (ctx.store && !already) {
          ctx.store.recordApproval({
            runId: s.runId,
            gate: "spec",
            decision: "approve",
            actor: "auto",
            comment: s.specCommit,
          });
        }
        return Promise.resolve({ specDecision: "approve" as const });
      }
      // interrupt() validates the resume value with responseSchema; parse again for the type.
      const answer: unknown = interrupt(
        { gate: "spec", runId: s.runId, changeId: s.task.id, specCommit: s.specCommit },
        { responseSchema: SpecApprovalAnswerSchema },
      );
      const parsed = SpecApprovalAnswerSchema.parse(answer);
      return Promise.resolve({
        specDecision: parsed.decision,
        specRejections:
          parsed.decision === "reject"
            ? [...s.specRejections, parsed.comment ?? ""]
            : s.specRejections,
      });
    }),

    develop: node("develop", async (s) => {
      if (!s.planResult) throw new Error("develop without a plan");
      if (!s.headCommit) throw new Error("develop without a snapshot commit");
      const wt = requireWorktree(s);
      // Replay safety: start from the last snapshot, discarding anything a crashed
      // previous attempt of this node may have left behind.
      await resetWorktree(wt, s.headCommit, worktreesRoot);
      const cycle = s.cycle + 1;
      const { update } = await agentStep(
        ctx,
        s,
        "developer",
        cycle,
        developerPrompt(s.task, s.planResult, fixFeedback(s, cycle), await approvedSpec(s)),
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
        // Scope covers the developer's work only: everything after the approved spec commit.
        changedFiles: (await changedFiles(wt, s.specCommit ?? wt.baseCommit)).map((f) => f.path),
        policyViolations: await specPolicyViolations(s),
        allowedPaths: s.task.scope.allowed_paths,
        checks: config.target.checks,
        checkTimeoutMs: Math.max(
          1,
          Math.min(config.stepTimeoutsMinutes.check * 60_000, s.deadlineMs - ctx.deadlineNow()),
        ),
        exec,
        logDir: checksDir(s),
        logPrefix: `c${s.cycle}`,
      });
      if (dbStep) {
        ctx.store?.finishStep(dbStep.id, {
          status: gate.passed ? "ok" : "failed",
          logPath: checksDir(s),
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
      const diff = await diffFromBase(wt, s.specCommit ?? wt.baseCommit);
      const { res, update } = await agentStep(
        ctx,
        s,
        "reviewer",
        s.cycle,
        reviewerPrompt(s.task, diff, config.maxDiffCharsForReview, await approvedSpec(s)),
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
      const decision = decide(s, ctx.deadlineNow());
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
      // Agent attempts cut short by a crash (marked abandoned on resume) cost an unknown amount.
      const abandonedAgentSteps = ctx.store
        ? ctx.store
            .listSteps(s.runId)
            .filter((st) => st.status === "abandoned" && AGENT_STEP_NODES.has(st.node)).length
        : 0;
      const unknownCostSteps = s.unknownCostSteps + abandonedAgentSteps;
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
        spec:
          s.specAttempts > 0
            ? {
                changeId: s.task.id,
                approvalMode: s.specApprovalMode,
                commit: s.specCommit,
                valid: s.specValid,
                attempts: s.specAttempts,
                change: s.spec,
                files: s.specFiles,
                rejections: s.specRejections,
              }
            : null,
        fixCycles: Math.max(0, s.cycle),
        steps: s.steps,
        review: s.reviewVerdict,
        gate: s.gateResult,
        cost: {
          totalUsd: roundUsd(s.spentUsd),
          budgetUsd: s.task.budget.max_cost_usd,
          unknownCostSteps,
        },
        changedFiles: files,
        diff,
      });
      await mkdir(s.runDir, { recursive: true });
      const reportJsonPath = path.join(s.runDir, "report.json");
      const reportMdPath = path.join(s.runDir, "report.md");
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
          unknownCostSteps,
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
