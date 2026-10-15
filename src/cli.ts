import path from "node:path";
import { parseCliArgs, USAGE } from "./cli-args.js";
import { loadConfig } from "./config/load-config.js";
import { runHiddenTests } from "./eval/hidden-tests.js";
import { runEval } from "./eval/run-eval.js";
import { listTaskIds, loadEvalMeta, loadTaskSpec } from "./eval/tasks.js";
import { ensureTargetRepo } from "./git/target-repo.js";
import { FACTORY_ROOT } from "./paths.js";
import { defaultSandboxExec, resumeRun, runTask } from "./pipeline/run-task.js";
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

async function runOne(taskId: string): Promise<number> {
  const config = await loadConfig();
  const task = await loadTaskSpec(taskId);
  const runtime = new ClaudeCodeRuntime({ logDir: RUNS_DIR, models: config.models });
  console.log(
    `Running task ${task.id} (budget $${task.budget.max_cost_usd}, ${task.budget.timeout_minutes} min)`,
  );
  const store = new Store(openDb());
  const { report, reportMdPath } = await runTask(task, {
    config,
    runtime,
    runsDir: RUNS_DIR,
    store,
    log: (m) => {
      console.log(m);
    },
  });
  store.db.close();
  console.log(
    `\n${report.status.toUpperCase()}: ${report.message}\n` +
      `cost $${report.cost.totalUsd.toFixed(3)}, ${Math.round(report.durationMs / 1000)}s, fix cycles ${report.fixCycles}\n` +
      `report: ${path.relative(process.cwd(), reportMdPath)}`,
  );
  return report.status === "success" ? 0 : 1;
}

async function evalSuite(taskIds: string[]): Promise<number> {
  const config = await loadConfig();
  const ids = taskIds.length > 0 ? taskIds : await listTaskIds();
  const tasks = [];
  for (const id of ids) tasks.push({ task: await loadTaskSpec(id), meta: await loadEvalMeta(id) });
  const repo = await ensureTargetRepo(config.target, config.workdirAbs);
  const exec = await defaultSandboxExec(repo.dir);
  const runtime = new ClaudeCodeRuntime({ logDir: RUNS_DIR, models: config.models });
  const log = (m: string) => {
    console.log(m);
  };

  const store = new Store(openDb());
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
      return runTask(task, {
        config,
        runtime,
        runsDir,
        store,
        runContext: { mode: "eval", evalId, evalRepeat: 1, baselineCommit: repo.baseCommit },
        makeSandboxExec: () => Promise.resolve(exec),
        log,
      });
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
    if (res.kind === "finished") {
      console.log(
        `run ${runId} is already finished: ${res.run.status}${res.run.status_message ? ` (${res.run.status_message})` : ""}` +
          (res.run.report_path
            ? `\nreport: ${path.relative(process.cwd(), res.run.report_path)}`
            : ""),
      );
      return 0;
    }
    const report = res.result.report;
    console.log(
      `\n${report.status.toUpperCase()}: ${report.message}\n` +
        `cost $${report.cost.totalUsd.toFixed(3)}, fix cycles ${report.fixCycles}\n` +
        `report: ${path.relative(process.cwd(), res.result.reportMdPath)}`,
    );
    return report.status === "success" ? 0 : 1;
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
      return runOne(cmd.taskId);
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
