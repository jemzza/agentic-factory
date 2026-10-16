import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ResolvedConfig } from "../config/load-config.js";
import { ensureTargetRepo, type RepoRef, type TargetRepo } from "../git/target-repo.js";
import type { SandboxExec } from "../quality/gate.js";
import { ensureSandboxImage, runInSandbox } from "../quality/sandbox.js";
import type { AgentRuntime } from "../runtimes/types.js";
import type { TargetConfig } from "../schemas/config.js";
import type { RunReport } from "../schemas/report.js";
import type { SpecChange } from "../schemas/spec.js";
import type { TaskSpec } from "../schemas/task.js";
import type { RunRow, Store } from "../store/store.js";
import { Command, MemorySaver } from "@langchain/langgraph";
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
  ensureRepo?: (target: TargetConfig, workdir: string, from: RepoRef) => Promise<TargetRepo>;
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

/** A run either finished (with a report) or is paused at a human approval gate. */
export type RunOutcome =
  | ({ kind: "finished" } & RunTaskResult)
  | { kind: "awaiting"; gate: "spec" | "merge"; runId: string; noticePath: string };

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
  input: Record<string, unknown> | Command | null,
  fromNode: string,
): Promise<void> {
  const store = deps.store;
  let prev: { node: string; update: unknown } = { node: fromNode, update: null };
  const stream = await graph.stream(input as Parameters<typeof graph.stream>[0], {
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

/** After the stream ends: either the run finished (report written) or it waits for a human. */
async function settle(
  deps: RunTaskDeps,
  graph: ReturnType<typeof prepareGraph>["graph"],
  ctx: NodeContext,
  runId: string,
): Promise<RunOutcome> {
  const snap = await graph.getState(threadConfig(runId));
  if (snap.next.length === 0) {
    if (!ctx.result) throw new Error(`run ${runId} finished without a report`);
    return { kind: "finished", ...ctx.result };
  }
  if (!snap.next.includes("spec_approval")) {
    throw new Error(`run ${runId} stopped unexpectedly before ${snap.next.join(", ")}`);
  }
  const values = snap.values as {
    runDir: string;
    specCommit: string | null;
    specFiles: Record<string, string>;
    spec: SpecChange | null;
    task: TaskSpec;
  };
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
    spec: SpecChange | null;
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
      "```bash",
      `npm run approve -- ${runId} spec`,
      `npm run reject -- ${runId} spec --comment "what to change"`,
      "```",
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
  task: TaskSpec,
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

  store?.createRun({
    id: runId,
    taskId: task.id,
    mode,
    budgetUsd: task.budget.max_cost_usd,
    roles: rolesFor(config, runtime),
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
      repoRef: mode === "eval" ? "baseline" : "main",
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

  const probe = prepareGraph(deps, 0).graph;
  const snapshot = await probe.getState(threadConfig(runId));
  const values = snapshot.values as Partial<{ lastNode: string; runId: string }>;
  if (!values.runId) throw new Error(`run ${runId} has no checkpoint to resume from`);
  if (snapshot.next.length === 0) return { kind: "finished", run };
  const atGate =
    snapshot.next.includes("spec_approval") && snapshot.tasks.some((t) => t.interrupts.length > 0);
  if (atGate && opts.answer === undefined) return { kind: "awaiting_human", run };
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
