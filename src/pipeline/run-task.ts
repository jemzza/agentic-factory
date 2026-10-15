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
import type { Store } from "../store/store.js";
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
    roles: Object.fromEntries(
      (["planner", "developer", "reviewer"] as const).map((r) => [
        r,
        { runtime: runtime.name, model: config.models[r] },
      ]),
    ),
    evalId: deps.runContext?.evalId ?? null,
    evalRepeat: deps.runContext?.evalRepeat ?? null,
    baselineCommit: deps.runContext?.baselineCommit ?? null,
    startedAt: started.toISOString(),
  });

  const ctx: NodeContext = {
    config,
    runtime,
    store,
    runDir,
    ensureRepo: deps.ensureRepo ?? ensureTargetRepo,
    makeSandboxExec: deps.makeSandboxExec ?? defaultSandboxExec,
    now,
    log: deps.log ?? (() => undefined),
  };
  const graph = buildGraph(makeNodes(ctx), { now });

  const input = {
    runId,
    task,
    startedAtMs: started.getTime(),
    deadlineMs: started.getTime() + task.budget.timeout_minutes * 60_000,
  };

  // Every state change is journaled as a transition: "<node> → <next>" with the node's update.
  let prev: { node: string; update: unknown } = { node: "__start__", update: null };
  const stream = await graph.stream(input, {
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

  if (!ctx.result) throw new Error(`run ${runId} finished without a report`);
  return ctx.result;
}
