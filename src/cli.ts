import os from "node:os";
import path from "node:path";
import { parseCliArgs, USAGE } from "./cli-args.js";
import { loadConfig } from "./config/load-config.js";
import { runHiddenTests } from "./eval/hidden-tests.js";
import { runEval } from "./eval/run-eval.js";
import { listTaskIds, loadEvalMeta, loadTaskSpec } from "./eval/tasks.js";
import { BASELINE_TAG, ensureTargetRepo, moveBaselineTag } from "./git/target-repo.js";
import { FACTORY_ROOT } from "./paths.js";
import { defaultSandboxExec, resumeRun, runTask, type RunOutcome } from "./pipeline/run-task.js";
import { ClaudeCodeRuntime } from "./runtimes/claude-code.js";
import { verifyHiddenTests } from "./eval/verify-hidden.js";
import type { CommandResult } from "./process/run-command.js";
import { openDb } from "./store/db.js";
import { importRunReports } from "./store/import-runs.js";
import { Store } from "./store/store.js";

function describeRun(result: CommandResult | null): string {
  if (result === null) return "—";
  if (result.timedOut) return `timeout (${result.durationMs} ms)`;
  return `exit ${result.exitCode ?? "?"} (${result.durationMs} ms)`;
}

async function verifyHidden(taskId: string | null): Promise<number> {
  const ids = taskId === null ? await listTaskIds() : [taskId];
  let failures = 0;
  for (const id of ids) {
    const v = await verifyHiddenTests(id);
    if (!v.ok) failures++;
    console.log(
      `${v.ok ? "PASS" : "FAIL"}  ${id.padEnd(16)} expected=${v.expected.padEnd(19)} ` +
        `baseline(hidden)=${describeRun(v.baseline).padEnd(20)} ` +
        `reference(check)=${describeRun(v.reference).padEnd(20)} ${v.reason}`,
    );
    if (!v.ok) {
      for (const r of [v.baseline, v.reference]) {
        if (r) console.log((r.stdout + r.stderr).split("\n").slice(-40).join("\n"));
      }
    }
  }
  console.log(`\n${ids.length - failures}/${ids.length} tasks have valid hidden tests`);
  return failures === 0 ? 0 : 1;
}

export const RUNS_DIR = path.join(FACTORY_ROOT, "runs");

function printOutcome(outcome: RunOutcome): number {
  if (outcome.kind === "awaiting") {
    console.log(
      `\nAWAITING ${outcome.gate.toUpperCase()} APPROVAL: review ${path.relative(process.cwd(), outcome.noticePath)}\n` +
        `  npm run approve -- ${outcome.runId} ${outcome.gate}\n` +
        `  npm run reject -- ${outcome.runId} ${outcome.gate} --comment "what to change"`,
    );
    return 0;
  }
  const { report } = outcome;
  console.log(
    `\n${report.status.toUpperCase()}: ${report.message}\n` +
      `cost $${report.cost.totalUsd.toFixed(3)}, ${Math.round(report.durationMs / 1000)}s, fix cycles ${report.fixCycles}\n` +
      `report: ${path.relative(process.cwd(), outcome.reportMdPath)}`,
  );
  return report.status === "success" ? 0 : 1;
}

const consoleLog = (m: string) => {
  console.log(m);
};

async function runOne(taskId: string, autoApproveSpec: boolean): Promise<number> {
  const config = await loadConfig();
  const task = await loadTaskSpec(taskId);
  const runtime = new ClaudeCodeRuntime({ logDir: RUNS_DIR, models: config.models });
  console.log(
    `Running task ${task.id} (budget $${task.budget.max_cost_usd}, ${task.budget.timeout_minutes} min, spec approval: ${autoApproveSpec ? "auto" : "manual"})`,
  );
  const store = new Store(openDb());
  try {
    const outcome = await runTask(task, {
      config,
      runtime,
      runsDir: RUNS_DIR,
      store,
      specApprovalMode: autoApproveSpec ? "auto" : "manual",
      log: consoleLog,
    });
    return printOutcome(outcome);
  } finally {
    store.db.close();
  }
}

const GATE_STATUS = { spec: "awaiting_spec_approval", merge: "awaiting_merge_approval" } as const;

/**
 * Human decision at an approval gate: record it in `approvals`, then resume the run with it.
 * Merge: a run already merged is a no-op that reports its status; any other status than
 * awaiting_merge_approval is refused. Nothing is ever merged without this command.
 */
async function decideGate(
  runId: string,
  gate: "spec" | "merge",
  decision: "approve" | "reject" | "merge" | "close",
  comment: string | null,
): Promise<number> {
  const config = await loadConfig();
  const store = new Store(openDb());
  try {
    const run = store.requireRun(runId);
    if (gate === "merge" && (run.status === "merged" || run.status === "closed")) {
      console.log(`run ${runId} is already ${run.status}: ${run.status_message}`);
      return 0;
    }
    if (run.status !== GATE_STATUS[gate]) {
      console.error(
        `error: run ${runId} is not waiting for a ${gate} decision (status: ${run.status}; expected ${GATE_STATUS[gate]})`,
      );
      return 2;
    }
    const actor = os.userInfo().username;
    store.recordApproval({ runId, gate, decision, actor, comment });
    const runtime = new ClaudeCodeRuntime({ logDir: RUNS_DIR, models: config.models });
    const res = await resumeRun(
      runId,
      { config, runtime, runsDir: RUNS_DIR, store, log: consoleLog },
      { answer: { decision, actor, ...(comment ? { comment } : {}) } },
    );
    if (res.kind !== "resumed") throw new Error(`run ${runId} could not be resumed (${res.kind})`);
    if (gate === "merge") {
      const after = store.requireRun(runId);
      console.log(`\n${after.status.toUpperCase()}: ${after.status_message}`);
      return after.status === "merged" || after.status === "closed" ? 0 : 1;
    }
    return printOutcome(res.outcome);
  } finally {
    store.db.close();
  }
}

/** Explicit, recorded move of the eval baseline tag (merges never move it). */
async function baselineUpdate(reason: string): Promise<number> {
  const config = await loadConfig();
  const repo = await ensureTargetRepo(config.target, config.workdirAbs, "main");
  const store = new Store(openDb());
  try {
    const { previous, current } = await moveBaselineTag(repo.dir);
    if (previous === current) {
      console.log(
        `${BASELINE_TAG} already points at main (${current.slice(0, 10)}); nothing to do`,
      );
      return 0;
    }
    store.recordBaseline({
      target: config.target.name,
      tag: BASELINE_TAG,
      commitHash: current,
      previousHash: previous,
      actor: os.userInfo().username,
      reason,
    });
    console.log(
      `${BASELINE_TAG}: ${previous.slice(0, 10)} → ${current.slice(0, 10)} (recorded). Eval metrics before and after are not comparable.`,
    );
    return 0;
  } finally {
    store.db.close();
  }
}

async function evalSuite(taskIds: string[]): Promise<number> {
  const config = await loadConfig();
  const ids = taskIds.length > 0 ? taskIds : await listTaskIds();
  const tasks = [];
  for (const id of ids) tasks.push({ task: await loadTaskSpec(id), meta: await loadEvalMeta(id) });
  // Eval always starts from the immutable baseline tag.
  const repo = await ensureTargetRepo(config.target, config.workdirAbs, "baseline");
  const exec = await defaultSandboxExec(repo.dir);
  const runtime = new ClaudeCodeRuntime({ logDir: RUNS_DIR, models: config.models });
  const log = (m: string) => {
    console.log(m);
  };

  const store = new Store(openDb());
  if (repo.baselineCreated && repo.baselineCommit) {
    store.recordBaseline({
      target: config.target.name,
      tag: BASELINE_TAG,
      commitHash: repo.baselineCommit,
      actor: "factory",
      reason: "initial materialization",
    });
  }
  // Set by the runTask callback (assigned in a closure, so kept in an object).
  const current: { evalId: string | null } = { evalId: null };
  console.log(`Eval: ${tasks.length} task(s), sequential`);
  const { summary, summaryMdPath } = await runEval(tasks, {
    runsDir: RUNS_DIR,
    runtimeName: runtime.name,
    models: config.models,
    costCapUsd: config.evalCostCapUsd,
    log,
    runTask: async (task, runsDir) => {
      // The eval directory name is the eval id (runs/eval-<ts>).
      const evalId = path.basename(runsDir);
      current.evalId = evalId;
      if (!store.getEval(evalId)) {
        store.createEval({
          id: evalId,
          repeatCount: 1,
          baselineCommit: repo.baseCommit,
          costCapUsd: null,
        });
      }
      const outcome = await runTask(task, {
        config,
        runtime,
        runsDir,
        store,
        runContext: { mode: "eval", evalId, evalRepeat: 1, baselineCommit: repo.baseCommit },
        makeSandboxExec: () => Promise.resolve(exec),
        log,
      });
      // Eval approves specs automatically, so a run can only pause at the merge gate (Phase 5).
      if (outcome.kind !== "finished")
        throw new Error(`eval run paused at ${outcome.gate} approval`);
      return outcome;
    },
    runHidden: (worktreePath, taskId) =>
      runHiddenTests({
        worktreePath,
        taskId,
        exec,
        timeoutMs: config.stepTimeoutsMinutes.check * 60_000,
      }),
  });
  const m = summary.metrics;
  if (current.evalId) {
    store.finishEval(current.evalId, {
      status: summary.costCap?.reached ? "cost_cap_reached" : "completed",
      costUsd: m.totalCostUsd,
      summaryPath: summaryMdPath,
    });
  }
  store.db.close();
  const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
  console.log(
    `\nverified rate ${pct(m.verifiedRate)} (${m.correct}/${m.total}), ` +
      `false success rate ${pct(m.falseSuccessRate)} (${m.falseSuccess}/${m.successClaims}), ` +
      `avg fix cycles ${m.avgFixCycles ?? "n/a"}, avg time ${m.avgDurationSec}s, total $${m.totalCostUsd.toFixed(3)}\n` +
      `summary: ${path.relative(process.cwd(), summaryMdPath)}`,
  );
  return m.hiddenLeaks === 0 ? 0 : 1;
}

async function resumeOne(runId: string): Promise<number> {
  const config = await loadConfig();
  const store = new Store(openDb());
  try {
    const runtime = new ClaudeCodeRuntime({ logDir: RUNS_DIR, models: config.models });
    const res = await resumeRun(runId, {
      config,
      runtime,
      runsDir: RUNS_DIR,
      store,
      log: (m) => {
        console.log(m);
      },
    });
    if (res.kind === "awaiting_human") {
      console.log(
        `run ${runId} is waiting for a human decision (${res.run.status}); use approve/reject`,
      );
      return 0;
    }
    if (res.kind === "finished") {
      console.log(
        `run ${runId} is already finished: ${res.run.status}${res.run.status_message ? ` (${res.run.status_message})` : ""}` +
          (res.run.report_path
            ? `\nreport: ${path.relative(process.cwd(), res.run.report_path)}`
            : ""),
      );
      return 0;
    }
    return printOutcome(res.outcome);
  } finally {
    store.db.close();
  }
}

function listRuns(limit: number): number {
  const store = new Store(openDb());
  const rows = store.listRuns({ limit });
  for (const r of rows) {
    console.log(
      `${r.id}  ${r.task_id.padEnd(16)} ${r.status.padEnd(24)} ${r.mode.padEnd(11)} ` +
        `$${r.cost_usd.toFixed(3).padStart(6)}  cycles ${r.fix_cycles}  ${r.started_at}`,
    );
  }
  if (rows.length === 0) console.log("(no runs in the database)");
  store.db.close();
  return 0;
}

async function dbImport(): Promise<number> {
  const store = new Store(openDb());
  const res = await importRunReports(store, RUNS_DIR);
  console.log(
    `imported ${res.imported.length}, already present ${res.skipped.length}, invalid ${res.invalid.length}`,
  );
  for (const i of res.invalid) console.log(`  invalid: ${i.file}: ${i.error}`);
  store.db.close();
  return res.invalid.length === 0 ? 0 : 1;
}

async function main(argv: readonly string[]): Promise<number> {
  const cmd = parseCliArgs(argv);
  switch (cmd.kind) {
    case "help":
      console.log(USAGE);
      return 0;
    case "invalid":
      console.error(`error: ${cmd.message}\n\n${USAGE}`);
      return 2;
    case "verify-hidden":
      return verifyHidden(cmd.taskId);
    case "run":
      return runOne(cmd.taskId, cmd.autoApproveSpec);
    case "decide":
      return decideGate(cmd.runId, cmd.gate, cmd.decision, cmd.comment);
    case "baseline-update":
      return baselineUpdate(cmd.reason);
    case "eval":
      return evalSuite(cmd.taskIds);
    case "runs":
      return listRuns(cmd.limit);
    case "resume":
      return resumeOne(cmd.runId);
    case "db-import":
      return dbImport();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  },
);
