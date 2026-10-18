import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ResolvedConfig } from "../config/load-config.js";
import { git } from "../git/git.js";
import { readProjectConfig } from "../config/projects.js";
import { hostSuspend } from "../process/host-suspend.js";
import {
  ensureTargetRepo,
  type ProjectSource,
  type RepoRef,
  type TargetRepo,
} from "../git/target-repo.js";
import type { SandboxExec } from "../quality/gate.js";
import { ensureSandboxImage, runInSandbox, type SandboxProfile } from "../quality/sandbox.js";
import type { AgentRole, AgentRuntime } from "../runtimes/types.js";
import { RunReportSchema, type RunReport } from "../schemas/report.js";
import type { PersistedSpecChange } from "../schemas/spec.js";
import { resolveTask, type TaskFile, type TaskSpec } from "../schemas/task.js";
import type { RunRow, Store } from "../store/store.js";
import { Command, MemorySaver } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { buildGraph } from "../workflow/graph.js";
import { makeNodes, type NodeContext } from "../workflow/nodes.js";

export interface RunTaskDeps {
  config: ResolvedConfig;
  /** Default runtime for every role. */
  runtime: AgentRuntime;
  /** Per-role overrides (e.g. an OpenCode reviewer), built from the config's role bindings. */
  runtimes?: Partial<Record<AgentRole, AgentRuntime>>;
  /** Directory for run outputs (`runs/`). */
  runsDir: string;
  /** The project (projects.yaml entry, or the eval stand's source override). */
  project: ProjectSource;
  /** Returns a sandbox executor for the project's profile. Default: Docker sandbox. */
  makeSandboxExec?: (repoDir: string, profile: SandboxProfile) => Promise<SandboxExec>;
  /** Materializes the project's repo. Default: ensureTargetRepo. */
  ensureRepo?: (project: ProjectSource, workdir: string, from: RepoRef) => Promise<TargetRepo>;
  now?: () => Date;
  /** Progress messages for the CLI. */
  log?: (message: string) => void;
  /** Source of truth for run history. Optional so unit tests can run without a DB. */
  store?: Store;
  /** How this run was started (recorded in the DB). Default: interactive. */
  runContext?: {
    mode: "interactive" | "eval";
    evalId?: string;
    evalRepeat?: number;
    baselineCommit?: string;
  };
  /**
   * Spec approval for interactive runs: "manual" (default) stops at spec_approval until a
   * human approves or rejects; "auto" approves and records `approval: auto`. Eval runs are
   * always "auto" so they can run unattended.
   */
  specApprovalMode?: "manual" | "auto";
}

export interface RunTaskResult {
  report: RunReport;
  reportJsonPath: string;
  reportMdPath: string;
}

/**
 * A run either finished (with a report) or is paused at a human approval gate. At the merge
 * gate the report already exists (`result`): the run succeeded and waits for a human merge.
 */
export type RunOutcome =
  | ({ kind: "finished" } & RunTaskResult)
  | {
      kind: "awaiting";
      gate: "spec" | "merge";
      runId: string;
      noticePath: string;
      result?: RunTaskResult;
    };

/** Report written by an earlier process (e.g. before a merge decision). */
async function loadResult(runDir: string): Promise<RunTaskResult> {
  const reportJsonPath = path.join(runDir, "report.json");
  const report = RunReportSchema.parse(JSON.parse(await readFile(reportJsonPath, "utf8")));
  return { report, reportJsonPath, reportMdPath: path.join(runDir, "report.md") };
}

export function makeRunId(now: Date): string {
  const ts = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${ts}-${randomBytes(2).toString("hex")}`;
}

export const defaultSandboxExec = async (
  repoDir: string,
  profile: SandboxProfile,
): Promise<SandboxExec> => {
  const image = await ensureSandboxImage(repoDir, profile);
  return (worktreePath, command, timeoutMs) =>
    runInSandbox(worktreePath, command, timeoutMs, { image });
};

/** Upper bound on graph steps; the longest path (3 dev/gate/review cycles) is ~14. */
const RECURSION_LIMIT = 50;

function rolesFor(config: ResolvedConfig, runtime: AgentRuntime, deps: RunTaskDeps) {
  return Object.fromEntries(
    (["planner", "developer", "reviewer"] as const).map((r) => [
      r,
      { runtime: (deps.runtimes?.[r] ?? runtime).name, model: config.models[r] },
    ]),
  );
}

/**
 * Builds the node context and the compiled graph. With a store the graph is checkpointed in
 * the same SQLite file (thread_id = runId); without one (unit tests) it uses memory.
 */
function prepareGraph(deps: RunTaskDeps, pausedMs: number) {
  const now = deps.now ?? (() => new Date());
  // Time the host slept while this process drove the run does not count against its deadline.
  const since = Date.now();
  const ctx: NodeContext = {
    config: deps.config,
    runtimeFor: (role) => deps.runtimes?.[role] ?? deps.runtime,
    store: deps.store,
    project: deps.project,
    ensureRepo: deps.ensureRepo ?? ensureTargetRepo,
    makeSandboxExec: deps.makeSandboxExec ?? defaultSandboxExec,
    now,
    deadlineNow: () => now().getTime() - pausedMs - hostSuspend.suspendedWithin(since, Date.now()),
    log: deps.log ?? (() => undefined),
  };
  const checkpointer = deps.store ? new SqliteSaver(deps.store.db) : new MemorySaver();
  const graph = buildGraph(makeNodes(ctx), { deadlineNow: ctx.deadlineNow, checkpointer });
  return { ctx, graph };
}

const threadConfig = (runId: string) => ({ configurable: { thread_id: runId } });

/**
 * Streams the graph to completion (or to an interrupt) and journals every state change
 * as a transition event: "<node> → <next>" carrying the node's update.
 */
async function drive(
  deps: RunTaskDeps,
  graph: ReturnType<typeof prepareGraph>["graph"],
  runId: string,
  input: Record<string, unknown> | Command | null,
  fromNode: string,
): Promise<void> {
  const store = deps.store;
  let prev: { node: string; update: unknown } = { node: fromNode, update: null };
  let interrupted = false;
  const stream = await graph.stream(input as Parameters<typeof graph.stream>[0], {
    ...threadConfig(runId),
    streamMode: "updates",
    recursionLimit: RECURSION_LIMIT,
  });
  for await (const chunk of stream) {
    for (const [nodeName, update] of Object.entries(chunk as Record<string, unknown>)) {
      // A pause is reported as a pseudo-node; the transition goes to the waiting node below.
      if (nodeName === "__interrupt__") {
        interrupted = true;
        continue;
      }
      store?.appendEvent(runId, {
        kind: "transition",
        node: prev.node,
        next: nodeName,
        payload: prev.update,
      });
      prev = { node: nodeName, update };
    }
  }
  const next = interrupted
    ? ((await graph.getState(threadConfig(runId))).next[0] ?? "__interrupt__")
    : "__end__";
  store?.appendEvent(runId, { kind: "transition", node: prev.node, next, payload: prev.update });
}

/** After the stream ends: either the run finished (report written) or it waits for a human. */
async function settle(
  deps: RunTaskDeps,
  graph: ReturnType<typeof prepareGraph>["graph"],
  ctx: NodeContext,
  runId: string,
): Promise<RunOutcome> {
  const snap = await graph.getState(threadConfig(runId));
  const values = snap.values as {
    runDir: string;
    specCommit: string | null;
    specFiles: Record<string, string>;
    spec: PersistedSpecChange | null;
    task: TaskSpec;
    worktree: { branch: string } | null;
    mergeOutcome: { kind: string; reason?: string } | null;
  };
  if (snap.next.length === 0) {
    return { kind: "finished", ...(ctx.result ?? (await loadResult(values.runDir))) };
  }

  if (snap.next.includes("merge_approval")) {
    const result = ctx.result ?? (await loadResult(values.runDir));
    const blockedReason =
      values.mergeOutcome?.kind === "blocked" ? (values.mergeOutcome.reason ?? "") : null;
    const noticePath = path.join(values.runDir, "merge-approval.md");
    await writeFile(
      noticePath,
      [
        `# Merge decision needed — ${values.task.title} (\`${values.task.id}\`)`,
        blockedReason
          ? `**The last merge attempt was blocked:** ${blockedReason}`
          : `The run passed the sandboxed gate and the review. Nothing is merged without you.`,
        `- Branch: \`${values.worktree?.branch ?? "?"}\``,
        `- Report: ${result.reportMdPath}`,
        [
          "```bash",
          `npm run merge -- ${runId}`,
          `npm run close -- ${runId} --comment "why not merged"`,
          "```",
        ].join("\n"),
        "`merge` re-runs the gate on the merge result with the current main and moves main only if it passes.",
      ].join("\n\n") + "\n",
    );
    deps.store?.updateRun(runId, {
      status: "awaiting_merge_approval",
      statusMessage: blockedReason
        ? `merge blocked: ${blockedReason}`
        : `ready to merge: ${noticePath}`,
    });
    deps.store?.appendEvent(runId, {
      kind: "interrupt",
      node: "merge_approval",
      payload: { blocked: blockedReason },
    });
    deps.log?.(`⏸ waiting for a merge decision — see ${noticePath}`);
    return { kind: "awaiting", gate: "merge", runId, noticePath, result };
  }

  if (!snap.next.includes("spec_approval")) {
    throw new Error(`run ${runId} stopped unexpectedly before ${snap.next.join(", ")}`);
  }
  const noticePath = path.join(values.runDir, "spec-approval.md");
  await writeFile(noticePath, renderSpecApprovalNotice(runId, values));
  deps.store?.updateRun(runId, {
    status: "awaiting_spec_approval",
    statusMessage: `OpenSpec change ready for review: ${noticePath}`,
  });
  deps.store?.appendEvent(runId, {
    kind: "interrupt",
    node: "spec_approval",
    payload: { specCommit: values.specCommit },
  });
  deps.log?.(`⏸ waiting for spec approval — see ${noticePath}`);
  return { kind: "awaiting", gate: "spec", runId, noticePath };
}

function renderSpecApprovalNotice(
  runId: string,
  v: {
    specCommit: string | null;
    specFiles: Record<string, string>;
    spec: PersistedSpecChange | null;
    task: TaskSpec;
  },
): string {
  const files = Object.entries(v.specFiles)
    .filter(([p]) => p.endsWith(".md"))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([p, c]) => `### \`${p}\`\n\n\`\`\`\`markdown\n${c.trim()}\n\`\`\`\``)
    .join("\n\n");
  const requirements = (v.spec?.capabilities ?? []).flatMap((c) =>
    c.requirements.map((r) => ({ capability: c.path, ...r })),
  );
  const traced = requirements
    .map((r) => {
      if (r.source === undefined)
        return `- **${r.name}** (\`${r.capability}\`) ← not recorded (spec predates sources)`;
      const n = /^acceptance:(\d+)$/.exec(r.source)?.[1];
      const criterion = n === undefined ? undefined : v.task.acceptance_criteria[Number(n) - 1];
      const from =
        criterion === undefined
          ? "existing behavior"
          : `acceptance criterion ${n ?? ""}: “${criterion}”`;
      return `- **${r.name}** (\`${r.capability}\`) ← ${from}`;
    })
    .join("\n");
  const fromExisting = requirements.filter((r) => r.source === "existing_behavior");
  return (
    [
      `# Spec approval needed — ${v.task.title} (\`${v.task.id}\`)`,
      `Run \`${runId}\`, spec commit \`${v.specCommit ?? "?"}\`. Implementation starts only after approval.`,
      [
        "```bash",
        `npm run approve -- ${runId} spec`,
        `npm run reject -- ${runId} spec --comment "what to change"`,
        "```",
      ].join("\n"),
      "## ⚠ Requirements based on existing behavior — check these",
      fromExisting.length
        ? "These are not acceptance criteria; the planner states the code already behaves this way. Approve only if that is true and intended.\n\n" +
          fromExisting.map((r) => `- **${r.name}** (\`${r.capability}\`): ${r.text}`).join("\n")
        : "None: every requirement traces to an acceptance criterion.",
      "## Where each requirement comes from",
      traced || "(no requirements)",
      "## Files",
      files,
    ].join("\n\n") + "\n"
  );
}

/**
 * Runs one task through the workflow graph (docs/graph.md):
 * prepare → plan → spec_draft → spec_approval → develop → gate → review → … → report.
 * Never throws for agent/check failures: every outcome ends in a report with a status,
 * or the run pauses at a human approval gate (`awaiting`).
 * Success is decided only by external facts — gate exit codes and the reviewer's
 * structured verdict — never by the developer's message.
 */
export async function runTask(
  taskFile: TaskFile,
  deps: RunTaskDeps,
  opts: { runId?: string } = {},
): Promise<RunOutcome> {
  const now = deps.now ?? (() => new Date());
  const { config, runtime, store } = deps;
  const started = now();
  const runId = opts.runId ?? makeRunId(started);
  const runDir = path.join(deps.runsDir, runId);
  await mkdir(runDir, { recursive: true });
  const mode = deps.runContext?.mode ?? "interactive";
  const specApprovalMode = mode === "eval" ? "auto" : (deps.specApprovalMode ?? "manual");
  const repoRef: RepoRef = mode === "eval" ? "baseline" : "main";

  // The project's rules come from its main clone as committed (eval: at the baseline tag),
  // read once here and frozen in the run state. Missing task scope/budget take its defaults.
  const repo = await (deps.ensureRepo ?? ensureTargetRepo)(
    deps.project,
    config.workdirAbs,
    repoRef,
  );
  const projectConfig = await readProjectConfig(repo.dir, repo.baseCommit);
  if (repoRef === "main") {
    const branch = (await git(repo.dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (branch !== projectConfig.config.target_branch) {
      throw new Error(
        `${repo.dir} has ${branch} checked out, but the project's target_branch is ${projectConfig.config.target_branch}`,
      );
    }
  }
  const task = resolveTask(taskFile, {
    scope: projectConfig.config.scope,
    budget: projectConfig.config.budget_defaults,
  });

  store?.createRun({
    id: runId,
    projectId: deps.project.id,
    taskId: task.id,
    mode,
    budgetUsd: task.budget.max_cost_usd,
    roles: rolesFor(config, runtime, deps),
    specApproval: specApprovalMode,
    evalId: deps.runContext?.evalId ?? null,
    evalRepeat: deps.runContext?.evalRepeat ?? null,
    baselineCommit: deps.runContext?.baselineCommit ?? null,
    startedAt: started.toISOString(),
  });
  store?.acquireLock(runId);
  try {
    const { ctx, graph } = prepareGraph(deps, 0);
    const input = {
      runId,
      runDir,
      task,
      mode,
      specApprovalMode,
      repoRef,
      project: {
        id: deps.project.id,
        configCommit: projectConfig.commit,
        config: projectConfig.config,
      },
      startedAtMs: started.getTime(),
      deadlineMs: started.getTime() + task.budget.timeout_minutes * 60_000,
    };
    await drive(deps, graph, runId, input, "__start__");
    return await settle(deps, graph, ctx, runId);
  } finally {
    store?.releaseLock(runId);
  }
}

export type ResumeResult =
  | { kind: "resumed"; outcome: RunOutcome }
  | { kind: "finished"; run: RunRow }
  /** Paused at an approval gate: use approve/reject, not a plain resume. */
  | { kind: "awaiting_human"; run: RunRow };

/**
 * Continues a run from its last checkpoint (thread_id = runId).
 * - After a crash: the node that was running is executed again from its start; nodes that
 *   change files first reset the worktree to the last snapshot, so the replay does not
 *   duplicate changes. Steps the dead process left `running` are marked `abandoned`.
 * - At an approval gate: pass `answer` (the human decision); without it nothing happens.
 * Time between the last activity and the resume does not count against the task timeout.
 * Resuming a finished run does nothing and returns its status.
 */
export async function resumeRun(
  runId: string,
  deps: RunTaskDeps,
  opts: { answer?: unknown } = {},
): Promise<ResumeResult> {
  const store = deps.store;
  if (!store) throw new Error("resume requires the factory database");
  const run = store.getRun(runId);
  if (!run) throw new Error(`run ${runId} not found`);

  const probeParts = prepareGraph(deps, 0);
  const probe = probeParts.graph;
  const snapshot = await probe.getState(threadConfig(runId));
  const values = snapshot.values as Partial<{ lastNode: string; runId: string }>;
  if (!values.runId) throw new Error(`run ${runId} has no checkpoint to resume from`);
  if (snapshot.next.length === 0) return { kind: "finished", run };
  const atGate =
    (snapshot.next.includes("spec_approval") || snapshot.next.includes("merge_approval")) &&
    snapshot.tasks.some((t) => t.interrupts.length > 0);
  if (atGate && opts.answer === undefined) {
    // Nothing to execute. Re-derive the waiting status and notice from the checkpoint, so a
    // run whose status write was interrupted (e.g. a crash right after the pause) is repaired.
    if (run.status !== "awaiting_spec_approval" && run.status !== "awaiting_merge_approval") {
      await settle(deps, probe, probeParts.ctx, runId);
    }
    return { kind: "awaiting_human", run: store.requireRun(runId) };
  }
  if (!atGate && opts.answer !== undefined) {
    throw new Error(`run ${runId} is not waiting for an approval (status ${run.status})`);
  }

  store.acquireLock(runId);
  try {
    const now = (deps.now ?? (() => new Date()))().getTime();
    const downtimeMs = Math.max(0, now - Date.parse(run.updated_at));
    const pausedBefore = store
      .listEvents(runId)
      .filter((e) => e.kind === "resume")
      .reduce((sum, e) => {
        const p = JSON.parse(e.payload ?? "{}") as { pausedMs?: unknown };
        return sum + (typeof p.pausedMs === "number" ? p.pausedMs : 0);
      }, 0);
    const abandoned = store.abandonRunningSteps(runId);
    store.appendEvent(runId, {
      kind: "resume",
      node: snapshot.next.join(","),
      payload: {
        pausedMs: downtimeMs,
        abandonedSteps: abandoned,
        withAnswer: opts.answer !== undefined,
      },
    });
    store.updateRun(runId, { status: "running", statusMessage: "" });
    deps.log?.(`resuming ${runId} at ${snapshot.next.join(", ")} (abandoned steps: ${abandoned})`);
    const { ctx, graph } = prepareGraph(deps, pausedBefore + downtimeMs);
    const input = opts.answer === undefined ? null : new Command({ resume: opts.answer });
    await drive(deps, graph, runId, input, values.lastNode ?? "__start__");
    return { kind: "resumed", outcome: await settle(deps, graph, ctx, runId) };
  } finally {
    store.releaseLock(runId);
  }
}

/**
 * One-time migration for runs that finished before the merge gate existed (Phase 5): their
 * checkpoint ended at `report` with status success, so they never reached `merge_approval`.
 * Only such runs are accepted. Using LangGraph's `updateState` as the `report` node, the
 * checkpoint is re-routed through the CURRENT graph (success → merge_approval); the run then
 * pauses at the merge gate like any new run. No agent is called. The migration is journaled.
 */
export async function reopenForMerge(
  runId: string,
  deps: RunTaskDeps,
  actor: string,
): Promise<RunOutcome> {
  const store = deps.store;
  if (!store) throw new Error("reopen-merge requires the factory database");
  const run = store.requireRun(runId);
  if (run.status !== "success") {
    throw new Error(
      `run ${runId} has status ${run.status}; only a finished "success" run from before the merge gate can be reopened`,
    );
  }
  const { ctx, graph } = prepareGraph(deps, 0);
  const config = threadConfig(runId);
  const snap = await graph.getState(config);
  const values = snap.values as Partial<{
    runId: string;
    lastNode: string;
    status: string;
    worktree: { path: string; branch: string } | null;
    repo: { dir: string } | null;
  }>;
  if (!values.runId) throw new Error(`run ${runId} has no checkpoint`);
  if (snap.next.length > 0)
    throw new Error(`run ${runId} is not finished (next: ${snap.next.join(", ")})`);
  if (values.lastNode !== "report" || values.status !== "success") {
    throw new Error(
      `run ${runId} did not end at a successful report (last node ${values.lastNode ?? "?"})`,
    );
  }
  if (!values.worktree || !values.repo)
    throw new Error(`run ${runId} has no worktree or repo in its state`);
  await access(values.worktree.path);
  await git(values.repo.dir, ["rev-parse", "--verify", `refs/heads/${values.worktree.branch}`]);

  store.acquireLock(runId);
  try {
    await graph.updateState(config, {}, "report");
    const after = await graph.getState(config);
    if (!after.next.includes("merge_approval")) {
      throw new Error(
        `re-routing ${runId} did not reach merge_approval (next: ${after.next.join(", ") || "none"})`,
      );
    }
    store.appendEvent(runId, {
      kind: "transition",
      node: "report",
      next: "merge_approval",
      payload: {
        migration: "reopen-merge",
        reason: "run finished before the merge gate existed",
        actor,
      },
    });
    store.updateRun(runId, { status: "running", statusMessage: "reopened for the merge gate" });
    await drive(deps, graph, runId, null, "report");
    return await settle(deps, graph, ctx, runId);
  } finally {
    store.releaseLock(runId);
  }
}
