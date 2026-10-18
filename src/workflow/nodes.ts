import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { developerPrompt, type FixFeedback, type FixReason } from "../agents/developer.js";
import {
  parsePlannerResult,
  PLANNER_OUTPUT_SCHEMA,
  plannerPrompt,
  SPEC_OUTPUT_SCHEMA,
  specFixPrompt,
} from "../agents/planner.js";
import { interrupt, isGraphBubbleUp } from "@langchain/langgraph";
import { changeDir, renderSpecFiles, validateChange, writeSpecFiles } from "../spec/openspec.js";
import { checkSpec, type OpenSpecIssue } from "../schemas/spec.js";
import { archiveChange } from "../spec/openspec.js";
import { git } from "../git/git.js";
import {
  fastForwardMain,
  findMergeCommit,
  isMergedIntoMain,
  prepareMergeCandidate,
  removeTempWorktree,
} from "../git/merge.js";
import type { RemoteGit } from "../github/remote.js";
import {
  BASELINE_TAG,
  ensureHostDeps,
  fastForwardFromOrigin,
  type ProjectSource,
  type RepoRef,
} from "../git/target-repo.js";
import { buildSystemPrompt, promptVars } from "../agents/prompts.js";
import { readConventions } from "../config/projects.js";
import {
  isApproved,
  REVIEWER_OUTPUT_SCHEMA,
  reviewerPrompt,
  reviewWithRetry,
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
import { matchesAny } from "../quality/scope.js";
import type { SandboxProfile } from "../quality/sandbox.js";
import { developerTools, READ_ONLY_TOOLS } from "../runtimes/tool-policy.js";
import type { AgentRole, AgentRunResult, AgentRuntime } from "../runtimes/types.js";
import { profileChecks, splitCommand, type ProjectConfig } from "../schemas/project.js";
import { RunReportSchema, type RunReport, type StepResult } from "../schemas/report.js";
import { cycleLimits } from "../schemas/task.js";
import type { Store } from "../store/store.js";
import { decide } from "./decide.js";
import {
  MergeAnswerSchema,
  SpecApprovalAnswerSchema,
  type NodeName,
  type ProjectSnapshot,
  type RunStateUpdate,
  type RunStateValue,
  type StepError,
} from "./state.js";

/** Everything nodes need that is not state: services, paths, clock. Never checkpointed. */
export interface NodeContext {
  config: ResolvedConfig;
  /** Runtime serving each role (from the config's role bindings). */
  runtimeFor: (role: AgentRole) => AgentRuntime;
  store?: Store | undefined;
  /** The project this run belongs to (where its repository comes from). */
  project: ProjectSource;
  ensureRepo: (project: ProjectSource, workdir: string, from: RepoRef) => Promise<TargetRepo>;
  /**
   * GitHub projects: the merge first syncs the target branch from origin and, after the gate
   * passes on the merge result, pushes it there (never forced) before moving the local branch.
   */
  remote?: RemoteGit | undefined;
  makeSandboxExec: (repoDir: string, profile: SandboxProfile) => Promise<SandboxExec>;
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

/** The project's frozen settings; runs checkpointed before projects existed cannot continue. */
function projectOf(s: RunStateValue): ProjectSnapshot {
  if (!s.project) {
    throw new Error(
      "this run was started before projects existed (no project config in its checkpoint); re-run the task",
    );
  }
  return s.project;
}

export const sandboxProfile = (c: ProjectConfig): SandboxProfile => ({
  image: c.profile.image,
  dependencyFiles: c.profile.dependency_files,
});

/** Changed files under the project's protected paths: never allowed, whatever the scope. */
export function protectedPathViolations(c: ProjectConfig, changed: readonly string[]): string[] {
  return changed
    .filter((f) => matchesAny(f, c.scope.protected_paths))
    .map((f) => `\`${f}\` is a protected path of this project and may not be changed; revert it`);
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
      const kind: StepError["kind"] =
        err instanceof SandboxInfraError ? (err.hostSuspended ? "infra" : "sandbox") : "exception";
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
  const { config, store } = ctx;
  const project = projectOf(s).config;
  const runtime = ctx.runtimeFor(role);
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
    allowedTools:
      role === "developer" ? developerTools(project.profile.agent_commands) : [...READ_ONLY_TOOLS],
    timeoutMs,
    systemPrompt: await buildSystemPrompt(role, s.conventions, promptVars(project)),
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
    ...(res.modelsUsed ? { modelsUsed: res.modelsUsed } : {}),
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

/**
 * Why the developer is about to run again: a failed gate, or reviewer change requests after a
 * passed gate. Null for the first implementation.
 */
export function fixReason(s: RunStateValue): FixReason | null {
  if (s.cycle < 0 || !s.gateResult) return null;
  if (!s.gateResult.passed) return "gate_failure";
  return s.reviewVerdict ? "review_feedback" : null;
}

function fixFeedback(s: RunStateValue, cycle: number): FixFeedback | undefined {
  const reason = fixReason(s);
  if (cycle === 0 || !reason || !s.gateResult) return undefined;
  const limits = cycleLimits(s.task.budget);
  if (reason === "gate_failure") {
    return {
      reason,
      cycle: s.gateFixCycles + 1,
      maxCycles: limits?.gateFix ?? 0,
      gateFailures: describeGateFailures(s.gateResult),
      reviewIssues: [],
      unmetCriteria: [],
    };
  }
  const review = s.reviewVerdict;
  return {
    reason,
    cycle: s.reviewCycles + 1,
    maxCycles: limits?.review ?? 0,
    gateFailures: "",
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
  let execCache: { key: string; exec: Promise<SandboxExec> } | null = null;
  const execFor = (repoDir: string, c: ProjectConfig) => {
    const profile = sandboxProfile(c);
    const key = JSON.stringify([repoDir, profile]);
    if (execCache?.key !== key) execCache = { key, exec: ctx.makeSandboxExec(repoDir, profile) };
    return execCache.exec;
  };
  const hostDepsDir = (s: RunStateValue) => projectOf(s).config.profile.host_deps_dir;

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
      const project = projectOf(s);
      const fullRepo = await ctx.ensureRepo(ctx.project, config.workdirAbs, s.repoRef);
      const repo = { dir: fullRepo.dir, baseCommit: fullRepo.baseCommit };
      if (fullRepo.baselineCreated && fullRepo.baselineCommit && ctx.store) {
        ctx.store.recordBaseline({
          target: project.id,
          tag: BASELINE_TAG,
          commitHash: fullRepo.baselineCommit,
          actor: "factory",
          reason: "initial materialization",
        });
      }
      await ensureHostDeps(repo.dir, {
        install: splitCommand(project.config.profile.install) ?? [],
        hostDepsDir: project.config.profile.host_deps_dir,
      });
      const wt = await createWorktree({
        repoDir: repo.dir,
        baseCommit: repo.baseCommit,
        worktreesDir: worktreesRoot,
        taskId: s.task.id,
        runId: s.runId,
        hostDepsDir: project.config.profile.host_deps_dir,
      });
      ctx.log(`worktree: ${wt.path} (${wt.branch})`);
      await assertNoHiddenArtifacts(wt.path);
      await execFor(repo.dir, project.config); // build/verify the sandbox image up front
      // From the commit the project config was read from, never from the worktree: an agent
      // cannot change the conventions it is held to.
      const conventions = await readConventions(
        repo.dir,
        project.configCommit,
        project.config.conventions_file,
      );
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
        specRaw: planned.value.spec ?? null,
        spec: null,
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
      let raw: unknown = s.specRaw;
      let update: RunStateUpdate = {};
      if (attempt > 1) {
        // Second and last attempt: the Planner fixes its spec using the validation output.
        const fix = await agentStep(
          ctx,
          s,
          "planner",
          0,
          specFixPrompt(s.task, raw, s.specIssues),
          SPEC_OUTPUT_SCHEMA,
          "spec_draft",
        );
        update = fix.update;
        if (update.lastError) return { ...update, specAttempts: attempt };
        raw = fix.res.structured ?? null;
      }
      const prevSteps = (update.steps as StepResult[] | undefined) ?? [];
      const invalid = (issues: OpenSpecIssue[]): RunStateUpdate => ({
        ...update,
        specRaw: raw,
        specValid: false,
        specIssues: issues,
        specAttempts: attempt,
        headCommit: wt.baseCommit,
        steps: [...prevSteps, { kind: "spec", attempt, valid: false, issues, commit: null }],
      });

      // 1. Schema + sources. Failures take the same single fix attempt as openspec's.
      const checked = checkSpec(raw, s.task.acceptance_criteria.length);
      if (!checked.ok) {
        ctx.log(
          `  spec draft #${attempt}: schema check failed (${checked.issues.length} issue(s))`,
        );
        return { ...invalid(checked.issues), spec: null };
      }
      const spec = checked.value;

      // 2. Render and `openspec validate`. The spec is always the first change on the
      //    branch, so start from the base commit.
      await resetWorktree(wt, wt.baseCommit, worktreesRoot);
      const files = renderSpecFiles(
        s.task.id,
        spec,
        new Date(s.startedAtMs).toISOString().slice(0, 10),
      );
      await writeSpecFiles(wt.path, s.task.id, files);
      const validation = await validateChange(wt.path, s.task.id);
      if (validation.kind === "error") throw new Error(`openspec validate: ${validation.message}`);
      if (validation.kind === "invalid") {
        await resetWorktree(wt, wt.baseCommit, worktreesRoot);
        ctx.log(`  spec draft #${attempt}: invalid (${validation.issues.length} issue(s))`);
        return { ...invalid(validation.issues), spec, specFiles: files };
      }
      const commit = await snapshot(
        wt,
        `factory: ${s.task.id} OpenSpec change (draft #${attempt})`,
        hostDepsDir(s),
      );
      ctx.log(`  spec draft #${attempt}: valid (${changeDir(s.task.id)})`);
      ctx.store?.updateRun(s.runId, { headCommit: commit });
      return {
        ...update,
        specRaw: raw,
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
      const specRejections =
        parsed.decision === "reject"
          ? [...s.specRejections, parsed.comment ?? ""]
          : s.specRejections;
      ctx.store?.updateRun(s.runId, { specRevisions: specRejections.length });
      return Promise.resolve({ specDecision: parsed.decision, specRejections });
    }),

    develop: node("develop", async (s) => {
      if (!s.planResult) throw new Error("develop without a plan");
      if (!s.headCommit) throw new Error("develop without a snapshot commit");
      const wt = requireWorktree(s);
      // Replay safety: start from the last snapshot, discarding anything a crashed
      // previous attempt of this node may have left behind.
      await resetWorktree(wt, s.headCommit, worktreesRoot);
      const cycle = s.cycle + 1;
      // Which budget this run spends was decided on the edge into develop; count it here.
      const reason = fixReason(s);
      const gateFixCycles = s.gateFixCycles + (reason === "gate_failure" ? 1 : 0);
      const reviewCycles = s.reviewCycles + (reason === "review_feedback" ? 1 : 0);
      const counters = {
        gateFixCycles,
        reviewCycles,
        reworks: reason
          ? [
              ...s.reworks,
              {
                cycle,
                reason,
                ofKind: reason === "gate_failure" ? gateFixCycles : reviewCycles,
              },
            ]
          : s.reworks,
      };
      const { update } = await agentStep(
        ctx,
        s,
        "developer",
        cycle,
        developerPrompt(
          s.task,
          s.planResult,
          fixFeedback(s, cycle),
          await approvedSpec(s),
          projectOf(s).config.profile.self_check,
        ),
      );
      if (update.lastError) return { ...update, ...counters, cycle, reviewVerdict: null };
      const commit = await snapshot(
        wt,
        `factory: ${s.task.id} developer cycle ${cycle}`,
        hostDepsDir(s),
      );
      await assertNoHiddenArtifacts(wt.path);
      const steps: StepResult[] = [
        ...(update.steps as StepResult[]),
        { kind: "snapshot", cycle, commit, message: `developer cycle ${cycle}` },
      ];
      ctx.store?.updateRun(s.runId, {
        headCommit: commit,
        fixCycles: cycle,
        gateFixCycles,
        reviewCycles,
      });
      return { ...update, ...counters, steps, cycle, headCommit: commit, reviewVerdict: null };
    }),

    gate: node("gate", async (s) => {
      const wt = requireWorktree(s);
      if (!s.repo) throw new Error("gate without a target repo");
      const project = projectOf(s).config;
      const exec = await execFor(s.repo.dir, project);
      const started = ctx.now();
      ctx.log("→ quality gate…");
      const dbStep = ctx.store?.startStep(s.runId, "gate", s.cycle);
      // Scope covers the developer's work only: everything after the approved spec commit.
      const changed = (await changedFiles(wt, s.specCommit ?? wt.baseCommit)).map((f) => f.path);
      const gate = await runGate({
        worktreePath: wt.path,
        changedFiles: changed,
        policyViolations: [
          ...(await specPolicyViolations(s)),
          ...protectedPathViolations(project, changed),
        ],
        allowedPaths: s.task.scope.allowed_paths,
        checks: profileChecks(project),
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
      const prompt = reviewerPrompt(
        s.task,
        diff,
        config.maxDiffCharsForReview,
        await approvedSpec(s),
      );
      // Each attempt is a recorded agent step; accounting carries over between attempts.
      let state = s;
      const steps: StepResult[] = [];
      const { outcome } = await reviewWithRetry(
        async (p) => {
          const { res, update } = await agentStep(
            ctx,
            state,
            "reviewer",
            s.cycle,
            p,
            REVIEWER_OUTPUT_SCHEMA,
          );
          const newSteps = (update.steps as StepResult[] | undefined) ?? [];
          steps.push(...newSteps);
          state = {
            ...state,
            spentUsd: update.spentUsd ?? state.spentUsd,
            unknownCostSteps: update.unknownCostSteps ?? state.unknownCostSteps,
            steps: [...state.steps, ...newSteps],
          };
          return res;
        },
        prompt,
        s.task,
        ctx.log,
      );
      const update: RunStateUpdate = {
        spentUsd: state.spentUsd,
        unknownCostSteps: state.unknownCostSteps,
        steps,
      };
      if (!outcome.ok) return { ...update, lastError: { node: "review", ...outcome.error } };
      ctx.log(
        `  review: ${outcome.value.verdict}${isApproved(outcome.value) ? "" : " (not accepted)"}`,
      );
      return { ...update, reviewVerdict: outcome.value };
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
        wallDurationMs: finished.getTime() - s.startedAtMs,
        activeDurationMs: Math.max(0, ctx.deadlineNow() - s.startedAtMs),
        task: s.task,
        runtime: [
          ...new Set(
            (["planner", "developer", "reviewer"] as const).map((r) => ctx.runtimeFor(r).name),
          ),
        ].join("+"),
        models: { ...config.models },
        projectId: s.project?.id ?? ctx.project.id,
        target: s.repo
          ? {
              name: s.project?.id ?? ctx.project.id,
              repoDir: s.repo.dir,
              baseCommit: s.repo.baseCommit,
            }
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
        gateFixCycles: s.gateFixCycles,
        reviewCycles: s.reviewCycles,
        reworks: s.reworks,
        specRevisions: s.specRejections.length,
        firstPass: null,
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
          gateFixCycles: s.gateFixCycles,
          reviewCycles: s.reviewCycles,
          ...(s.worktree ? { headCommit: head } : {}),
          reportPath: reportMdPath,
          wallDurationMs: report.wallDurationMs ?? report.durationMs,
          activeDurationMs: report.activeDurationMs ?? report.durationMs,
        });
      }
      ctx.result = { report, reportJsonPath, reportMdPath };
      return { status, statusMessage: message };
    }),

    // Pure: on resume LangGraph re-runs it from the start and interrupt() returns the answer.
    merge_approval: node("merge_approval", (s) => {
      const answer: unknown = interrupt(
        {
          gate: "merge",
          runId: s.runId,
          branch: s.worktree?.branch ?? null,
          headCommit: s.headCommit,
          blocked: s.mergeOutcome?.kind === "blocked" ? s.mergeOutcome.reason : null,
        },
        { responseSchema: MergeAnswerSchema },
      );
      const parsed = MergeAnswerSchema.parse(answer);
      return Promise.resolve({
        mergeDecision: parsed.decision,
        mergeComment: parsed.comment ?? null,
        mergeOutcome: null,
      });
    }),

    /**
     * Merge, decided by a human only. The candidate is built from main's CURRENT head
     * (`--no-ff`, OpenSpec archived in the same commit), the gate runs on that candidate,
     * and only then main fast-forwards to it — if main did not move meanwhile.
     * The factory-baseline tag is never touched here.
     */
    merge: node("merge", async (s) => {
      const wt = requireWorktree(s);
      if (!s.repo || !s.headCommit) throw new Error("merge without a repo or head commit");
      const repoDir = s.repo.dir;
      const project = projectOf(s).config;
      const targetBranch = project.target_branch;
      const blocked = (reason: string): RunStateUpdate => {
        ctx.log(`  merge blocked: ${reason}`);
        return { mergeOutcome: { kind: "blocked", reason } };
      };

      // Replay after a crash: the branch may already be on main.
      if (await isMergedIntoMain(repoDir, s.headCommit, targetBranch)) {
        const mergeCommit = (await findMergeCommit(repoDir, s.runId, targetBranch)) ?? s.headCommit;
        ctx.store?.updateRun(s.runId, {
          status: "merged",
          statusMessage: `merged as ${mergeCommit}`,
        });
        return {
          mergeOutcome: { kind: "merged", mergeCommit, mainBefore: mergeCommit, archivedAs: null },
        };
      }

      const reportPath = path.join(s.runDir, "report.md");
      const message = [
        `Merge factory run ${s.runId}: ${s.task.title}`,
        "",
        `Task: ${s.task.id}`,
        `Report: ${reportPath}`,
        `Approved by: ${s.mergeComment ? `human (${s.mergeComment})` : "human"}`,
        "",
        `Factory-Run: ${s.runId}`,
        `Factory-Task: ${s.task.id}`,
      ].join("\n");
      if (ctx.remote) {
        try {
          await fastForwardFromOrigin(repoDir, targetBranch, ctx.remote);
        } catch (err) {
          return blocked(
            `could not bring ${targetBranch} up to date with GitHub: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      ctx.log("→ merge: building the merge result from current main…");
      const candidate = await prepareMergeCandidate({
        repoDir,
        branch: wt.branch,
        worktreesRoot,
        runId: s.runId,
        message,
        archive: async (dir) => (await archiveChange(dir, s.task.id))?.archivedAs ?? null,
        targetBranch,
        hostDepsDir: project.profile.host_deps_dir,
      });
      if (candidate.kind === "conflict") {
        return blocked(
          `merge conflicts with changes on main in: ${candidate.files.join(", ") || "(unknown files)"}. ` +
            `Rebase branch ${wt.branch} onto main (or re-run the task), then retry.`,
        );
      }

      try {
        ctx.log("→ quality gate on the merge result…");
        const changed = (
          await git(candidate.worktreePath, [
            "diff",
            "--name-only",
            candidate.mainBefore,
            candidate.mergeCommit,
          ])
        )
          .split("\n")
          .filter((f) => f.trim() !== "");
        const dbStep = ctx.store?.startStep(s.runId, "merge_gate", 0);
        const gate = await runGate({
          worktreePath: candidate.worktreePath,
          changedFiles: changed,
          policyViolations: protectedPathViolations(project, changed),
          // The merge also carries the approved spec and its archive.
          allowedPaths: [...s.task.scope.allowed_paths, "openspec/**"],
          checks: profileChecks(project),
          checkTimeoutMs: config.stepTimeoutsMinutes.check * 60_000,
          exec: await execFor(repoDir, project),
          logDir: checksDir(s),
          logPrefix: "merge",
        });
        if (dbStep) {
          ctx.store?.finishStep(dbStep.id, {
            status: gate.passed ? "ok" : "failed",
            logPath: checksDir(s),
            error: gate.passed
              ? null
              : { kind: "gate_failed", message: describeGateFailures(gate) },
          });
        }
        if (!gate.passed) {
          return blocked(
            `the quality gate failed on the merge result with current main:\n${describeGateFailures(gate)}`,
          );
        }
        if (ctx.remote) {
          const pushed = await ctx.remote.push(repoDir, candidate.mergeCommit, targetBranch);
          if (!pushed.ok) {
            return blocked(
              pushed.rejected
                ? `${targetBranch} moved on GitHub while the merge was being checked; retry the merge`
                : `pushing the merge to GitHub failed: ${pushed.message}`,
            );
          }
        }
        const ff = await fastForwardMain(
          repoDir,
          candidate.mainBefore,
          candidate.mergeCommit,
          targetBranch,
        );
        if (ff.kind === "main_moved") {
          return blocked(
            `main moved to ${ff.mainNow.slice(0, 10)} while the merge was being checked; retry the merge`,
          );
        }
      } finally {
        await removeTempWorktree(repoDir, candidate.worktreePath);
      }

      ctx.log(`  merged into main as ${candidate.mergeCommit.slice(0, 10)}`);
      ctx.store?.updateRun(s.runId, {
        status: "merged",
        statusMessage: `merged into main as ${candidate.mergeCommit}${candidate.archivedAs ? `; OpenSpec change archived as ${candidate.archivedAs}` : ""}`,
      });
      await writeFile(
        path.join(s.runDir, "merge.md"),
        [
          `# Merged — ${s.task.title} (\`${s.task.id}\`)`,
          `- Merge commit: \`${candidate.mergeCommit}\` (\`--no-ff\`, on top of main \`${candidate.mainBefore}\`)`,
          `- OpenSpec: ${candidate.archivedAs ? `archived as \`${candidate.archivedAs}\` in the same commit` : "nothing to archive"}`,
          `- Gate re-run on the merge result: passed`,
          `- Run report: ${reportPath}`,
        ].join("\n") + "\n",
      );
      return {
        mergeOutcome: {
          kind: "merged",
          mergeCommit: candidate.mergeCommit,
          mainBefore: candidate.mainBefore,
          archivedAs: candidate.archivedAs,
        },
      };
    }),

    close: node("close", (s) => {
      ctx.store?.updateRun(s.runId, {
        status: "closed",
        statusMessage: `closed without merge${s.mergeComment ? `: ${s.mergeComment}` : ""}`,
      });
      return Promise.resolve({});
    }),
  };
}
