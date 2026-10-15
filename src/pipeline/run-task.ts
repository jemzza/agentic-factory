import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { ResolvedConfig } from "../config/load-config.js";
import { ensureTargetRepo, type TargetRepo } from "../git/target-repo.js";
import type { SandboxExec } from "../quality/gate.js";
import { ensureSandboxImage, runInSandbox } from "../quality/sandbox.js";
import type { AgentRuntime } from "../runtimes/types.js";
import type { TargetConfig } from "../schemas/config.js";
import type { RunReport } from "../schemas/report.js";
import type { TaskSpec } from "../schemas/task.js";
import type { RunRow, Store } from "../store/store.js";
import { MemorySaver } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { buildGraph } from "../workflow/graph.js";
import { makeNodes, type NodeContext } from "../workflow/nodes.js";

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
  /** Source of truth for run history. Optional so unit tests can run without a DB. */
  store?: Store;
  /** How this run was started (recorded in the DB). Default: interactive. */
  runContext?: {
    mode: "interactive" | "eval";
    evalId?: string;
    evalRepeat?: number;
    baselineCommit?: string;
  };
}

export interface RunTaskResult {
  report: RunReport;
  reportJsonPath: string;
  reportMdPath: string;
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

/** Upper bound on graph steps; the longest path (3 dev/gate/review cycles) is ~14. */
const RECURSION_LIMIT = 50;

function rolesFor(config: ResolvedConfig, runtime: AgentRuntime) {
  return Object.fromEntries(
    (["planner", "developer", "reviewer"] as const).map((r) => [
      r,
      { runtime: runtime.name, model: config.models[r] },
    ]),
  );
}

/**
 * Builds the node context and the compiled graph. With a store the graph is checkpointed in
 * the same SQLite file (thread_id = runId); without one (unit tests) it uses memory.
 */
function prepareGraph(deps: RunTaskDeps, pausedMs: number) {
  const now = deps.now ?? (() => new Date());
  const ctx: NodeContext = {
    config: deps.config,
    runtime: deps.runtime,
    store: deps.store,
    ensureRepo: deps.ensureRepo ?? ensureTargetRepo,
    makeSandboxExec: deps.makeSandboxExec ?? defaultSandboxExec,
    now,
    deadlineNow: () => now().getTime() - pausedMs,
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
  input: Record<string, unknown> | null,
  fromNode: string,
): Promise<void> {
  const store = deps.store;
  let prev: { node: string; update: unknown } = { node: fromNode, update: null };
  const stream = await graph.stream(input, {
    ...threadConfig(runId),
    streamMode: "updates",
    recursionLimit: RECURSION_LIMIT,
  });
  for await (const chunk of stream) {
    for (const [nodeName, update] of Object.entries(chunk as Record<string, unknown>)) {
      store?.appendEvent(runId, {
        kind: "transition",
        node: prev.node,
        next: nodeName,
        payload: prev.update,
      });
      prev = { node: nodeName, update };
    }
  }
  store?.appendEvent(runId, {
    kind: "transition",
    node: prev.node,
    next: "__end__",
    payload: prev.update,
  });
}

/**
 * Runs one task through the workflow graph (docs/graph.md):
 * prepare → plan → spec_draft → spec_approval → develop → gate → review → … → report.
 * Never throws for agent/check failures: every outcome ends in a report with a status.
 * Success is decided only by external facts — gate exit codes and the reviewer's
 * structured verdict — never by the developer's message.
 */
export async function runTask(
  task: TaskSpec,
  deps: RunTaskDeps,
  opts: { runId?: string } = {},
): Promise<RunTaskResult> {
  const now = deps.now ?? (() => new Date());
  const { config, runtime, store } = deps;
  const started = now();
  const runId = opts.runId ?? makeRunId(started);
  const runDir = path.join(deps.runsDir, runId);
  await mkdir(runDir, { recursive: true });

  store?.createRun({
    id: runId,
    taskId: task.id,
    mode: deps.runContext?.mode ?? "interactive",
    budgetUsd: task.budget.max_cost_usd,
    roles: rolesFor(config, runtime),
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
      startedAtMs: started.getTime(),
      deadlineMs: started.getTime() + task.budget.timeout_minutes * 60_000,
    };
    await drive(deps, graph, runId, input, "__start__");
    if (!ctx.result) throw new Error(`run ${runId} finished without a report`);
    return ctx.result;
  } finally {
    store?.releaseLock(runId);
  }
}

export type ResumeResult =
  { kind: "resumed"; result: RunTaskResult } | { kind: "finished"; run: RunRow };

/**
 * Continues an interrupted run from its last checkpoint (thread_id = runId). The node that
 * was running when the process died is executed again from its start; nodes that change
 * files first reset the worktree to the last snapshot, so the replay does not duplicate
 * changes. Steps the dead process left `running` are marked `abandoned`. Time between the
 * last activity and the resume does not count against the task timeout.
 * Resuming a finished run does nothing and returns its status.
 */
export async function resumeRun(runId: string, deps: RunTaskDeps): Promise<ResumeResult> {
  const store = deps.store;
  if (!store) throw new Error("resume requires the factory database");
  const run = store.getRun(runId);
  if (!run) throw new Error(`run ${runId} not found`);

  const probe = prepareGraph(deps, 0).graph;
  const snapshot = await probe.getState(threadConfig(runId));
  const values = snapshot.values as Partial<{ lastNode: string; runId: string }>;
  if (!values.runId) throw new Error(`run ${runId} has no checkpoint to resume from`);
  if (snapshot.next.length === 0) return { kind: "finished", run };

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
      payload: { pausedMs: downtimeMs, abandonedSteps: abandoned },
    });
    deps.log?.(`resuming ${runId} at ${snapshot.next.join(", ")} (abandoned steps: ${abandoned})`);
    const { ctx, graph } = prepareGraph(deps, pausedBefore + downtimeMs);
    await drive(deps, graph, runId, null, values.lastNode ?? "__start__");
    if (!ctx.result) throw new Error(`run ${runId} finished without a report`);
    return { kind: "resumed", result: ctx.result };
  } finally {
    store.releaseLock(runId);
  }
}
