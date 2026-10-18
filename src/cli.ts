import os from "node:os";
import path from "node:path";
import { parseCliArgs, USAGE, type CliCommand } from "./cli-args.js";
import { loadConfig } from "./config/load-config.js";
import { runHiddenTests } from "./eval/hidden-tests.js";
import { rescoreEval } from "./eval/rescore.js";
import { checkProject } from "./config/project-check.js";
import { runDaemon } from "./github/daemon.js";
import { GhCli } from "./github/gh-cli.js";
import { ghRemote } from "./github/remote.js";
import { Watcher } from "./github/watch.js";
import { ensureSandboxImage, runInSandbox } from "./quality/sandbox.js";
import { runEvalRepeated } from "./eval/repeat.js";
import { listTaskIds, loadEvalMeta, loadTaskSpec } from "./eval/tasks.js";
import { writeFirstPass } from "./report/first-pass.js";
import {
  BASELINE_TAG,
  ensureTargetRepo,
  exportTree,
  moveBaselineTag,
  type ProjectSource,
} from "./git/target-repo.js";
import { findProject, loadRegistry, readProjectConfig } from "./config/projects.js";
import { loadEvalStand } from "./eval/stand.js";
import { sandboxProfile } from "./workflow/nodes.js";
import { TaskFileSchema, type TaskFile } from "./schemas/task.js";
import { FACTORY_ROOT } from "./paths.js";
import {
  defaultSandboxExec,
  reopenForMerge,
  resumeRun,
  runTask,
  type RunOutcome,
} from "./pipeline/run-task.js";
import type { ResolvedConfig } from "./config/load-config.js";
import { buildRuntimes, runtimeForBinding } from "./runtimes/registry.js";
import { ClaudeCodeRuntime } from "./runtimes/claude-code.js";
import { loadReviewCases, verifyManifest } from "./eval/review-cases.js";
import { renderReviewEvalMarkdown, runReviewEval } from "./eval/review-eval.js";
import { readFile, writeFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { git } from "./git/git.js";
import { createRedactor, secretsFromEnv } from "./store/redact.js";
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
  const stand = await loadEvalStand();
  let failures = 0;
  for (const id of ids) {
    const v = await verifyHiddenTests(id, { stand });
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

// Provider keys for non-Anthropic runtimes live in .env (git-ignored). They reach only the
// runtime that names them in keyEnv; Claude Code and the sandbox get explicit envs.
try {
  process.loadEnvFile(path.join(FACTORY_ROOT, ".env"));
} catch {
  // no .env: fine unless a role needs a key (the runtime then fails with a clear error)
}

/** The DB, masking every secret listed in config.secretEnv before anything is written. */
function openStore(config: ResolvedConfig): Store {
  return new Store(openDb(), { secrets: secretsFromEnv(config.secretEnv) });
}

/** One runtime per role from the config (switching runtimes is a config change). */
function runtimeDeps(config: ResolvedConfig) {
  const runtimes = buildRuntimes(config, RUNS_DIR);
  return { runtime: runtimes.developer, runtimes };
}

/**
 * Where a run's project comes from: eval runs use the eval stand's own source (never a remote);
 * interactive runs use the project's entry in projects.yaml.
 */
async function projectSourceFor(
  projectId: string,
  mode: "interactive" | "eval",
): Promise<ProjectSource> {
  if (mode === "eval") {
    const stand = await loadEvalStand();
    if (stand.project.id !== projectId) {
      throw new Error(
        `eval run of project ${projectId}, but the eval stand is ${stand.project.id}`,
      );
    }
    return stand.project;
  }
  const p = findProject(await loadRegistry(), projectId);
  return { id: p.id, source: p.source };
}

/**
 * The authenticated remote for a project on GitHub (CLI decisions on GitHub runs push like the
 * watcher does); undefined for local projects. Without the token a GitHub project cannot merge.
 */
async function remoteFor(config: ResolvedConfig, projectId: string, mode: "interactive" | "eval") {
  if (mode === "eval") return undefined;
  const p = findProject(await loadRegistry(), projectId);
  if (p.github === null) return undefined;
  const token = process.env[config.github.tokenEnv];
  if (!token) throw new Error(`${projectId} is on GitHub: set ${config.github.tokenEnv} in .env`);
  return ghRemote({ token });
}

/** A task to run: a YAML file (any project) or the id of an eval task (the eval stand). */
async function loadRunnableTask(task: string): Promise<TaskFile> {
  if (!task.endsWith(".yaml") && !task.endsWith(".yml")) return loadTaskSpec(task);
  const parsed = TaskFileSchema.safeParse(parseYaml(await readFile(task, "utf8")));
  if (!parsed.success) throw new Error(`Invalid ${task}: ${parsed.error.message}`);
  return parsed.data;
}

function printOutcome(outcome: RunOutcome): number {
  if (outcome.kind === "awaiting") {
    const next =
      outcome.gate === "spec"
        ? `  npm run approve -- ${outcome.runId} spec\n  npm run reject -- ${outcome.runId} spec --comment "what to change"`
        : `  npm run merge -- ${outcome.runId}\n  npm run close -- ${outcome.runId} --comment "why not merged"`;
    console.log(
      `\nAWAITING ${outcome.gate.toUpperCase()} DECISION: review ${path.relative(process.cwd(), outcome.noticePath)}\n${next}`,
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

async function runOne(
  projectId: string | null,
  taskRef: string,
  autoApproveSpec: boolean,
): Promise<number> {
  const config = await loadConfig();
  const task = await loadRunnableTask(taskRef);
  const project = await projectSourceFor(
    projectId ?? (await loadEvalStand()).project.id,
    "interactive",
  );
  const { runtime, runtimes } = runtimeDeps(config);
  console.log(
    `Running task ${task.id} in project ${project.id} (spec approval: ${autoApproveSpec ? "auto" : "manual"})`,
  );
  const store = openStore(config);
  try {
    const outcome = await runTask(task, {
      config,
      runtime,
      runtimes,
      runsDir: RUNS_DIR,
      project,
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
  const store = openStore(config);
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
    const { runtime, runtimes } = runtimeDeps(config);
    const project = await projectSourceFor(run.project_id, run.mode);
    const remote = await remoteFor(config, run.project_id, run.mode);
    const res = await resumeRun(
      runId,
      {
        config,
        runtime,
        runtimes,
        runsDir: RUNS_DIR,
        store,
        project,
        ...(remote ? { remote } : {}),
        log: consoleLog,
      },
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

/** Compares the configured reviewers on the frozen evals/review/ set. */
async function evalReview(only: string | null): Promise<number> {
  const config = await loadConfig();
  const stand = await loadEvalStand();
  const problems = await verifyManifest();
  if (problems.length) {
    console.error(`error: evals/review/ does not match its manifest:\n- ${problems.join("\n- ")}`);
    return 2;
  }
  const cases = await loadReviewCases();
  const evalId = `review-eval-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;
  const outDir = path.join(RUNS_DIR, evalId);
  const claude = new ClaudeCodeRuntime({ logDir: outDir, models: config.models });
  const reviewers = config.reviewEval.reviewers
    .filter((b) => only === null || b.runtime === only)
    .map((b) => ({
      label: `${b.runtime}:${b.model}`,
      model: b.model,
      runtime: runtimeForBinding(b, outDir, claude),
    }));
  console.log(`Reviewer eval: ${cases.length} cases × ${reviewers.map((r) => r.label).join(", ")}`);
  const results = await runReviewEval({
    cases,
    reviewers,
    loadTask: loadTaskSpec,
    baselineSource: stand.fixtureDir,
    projectConfig: stand.projectConfig,
    outDir,
    maxDiffChars: config.maxDiffCharsForReview,
    timeoutMs: config.stepTimeoutsMinutes.reviewer * 60_000,
    log: consoleLog,
  });
  const redact = createRedactor(secretsFromEnv(config.secretEnv));
  await writeFile(
    path.join(outDir, "summary.json"),
    redact(JSON.stringify({ evalId, results }, null, 2)),
  );
  const md = renderReviewEvalMarkdown(evalId, results);
  await writeFile(path.join(outDir, "summary.md"), redact(md));
  console.log(
    `\n${md.split("## Per case")[0]?.trim() ?? ""}\nsummary: ${path.relative(process.cwd(), path.join(outDir, "summary.md"))}`,
  );
  return 0;
}

async function reopenMerge(runId: string): Promise<number> {
  const config = await loadConfig();
  const store = openStore(config);
  try {
    const { runtime, runtimes } = runtimeDeps(config);
    const run = store.requireRun(runId);
    const project = await projectSourceFor(run.project_id, run.mode);
    const outcome = await reopenForMerge(
      runId,
      { config, runtime, runtimes, runsDir: RUNS_DIR, store, project, log: consoleLog },
      os.userInfo().username,
    );
    return printOutcome(outcome);
  } finally {
    store.db.close();
  }
}

/** Explicit, recorded move of the eval baseline tag (merges never move it). */
async function baselineUpdate(reason: string): Promise<number> {
  const config = await loadConfig();
  // The baseline tag is the eval stand's: eval runs start from it.
  const { project } = await loadEvalStand();
  const repo = await ensureTargetRepo(project, config.workdirAbs, "main");
  const { config: projectConfig } = await readProjectConfig(repo.dir, "HEAD");
  const store = openStore(config);
  try {
    const { previous, current } = await moveBaselineTag(repo.dir, projectConfig.target_branch);
    if (previous === current) {
      console.log(
        `${BASELINE_TAG} already points at main (${current.slice(0, 10)}); nothing to do`,
      );
      return 0;
    }
    store.recordBaseline({
      target: project.id,
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

/** Paths whose change alters what the agents are asked or allowed to do. */
const MEASUREMENT_PATHS = [
  "prompts",
  "factory.config.ts",
  "factory.sonnet-dev.config.ts",
  "src/agents",
  "src/runtimes",
];

/** The factory's own commit, with `-dirty` when tracked files have uncommitted changes. */
async function factoryCommit(): Promise<string> {
  const head = (await git(FACTORY_ROOT, ["rev-parse", "--short=12", "HEAD"])).trim();
  const dirty = (await git(FACTORY_ROOT, ["status", "--porcelain", "--untracked-files=no"])).trim();
  return dirty ? `${head}-dirty` : head;
}

/**
 * Measurement-relevant files changed since the commits that ran the earlier passes of an
 * eval. Returns the changed paths (empty = comparable). Passes without a recorded commit
 * cannot be checked automatically and are reported separately.
 */
async function changedSincePasses(
  evalDir: string,
): Promise<{ changed: string[]; unknown: number }> {
  const changed = new Set<string>();
  let unknown = 0;
  for (let i = 1; ; i++) {
    let raw: string;
    try {
      raw = await readFile(path.join(evalDir, `r${i}`, "summary.json"), "utf8");
    } catch {
      break;
    }
    const commit = (JSON.parse(raw) as { factoryCommit?: string | null }).factoryCommit ?? null;
    if (commit === null) {
      unknown++;
      continue;
    }
    const out = await git(FACTORY_ROOT, [
      "diff",
      "--name-only",
      commit.replace(/-dirty$/, ""),
      "--",
      ...MEASUREMENT_PATHS,
    ]);
    for (const f of out.split("\n").filter((l) => l.trim() !== "")) changed.add(f);
  }
  return { changed: [...changed], unknown };
}

async function evalSuite(cmd: Extract<CliCommand, { kind: "eval" }>): Promise<number> {
  const { taskIds, repeat } = cmd;
  const config = await loadConfig();
  const costCapUsd = cmd.costCapUsd ?? config.evalCostCapUsd;
  const commit = await factoryCommit();
  if (commit.endsWith("-dirty")) {
    console.warn(
      `Warning: the factory has uncommitted changes (${commit}); results are recorded as such.`,
    );
  }
  if (cmd.resume) {
    const { changed, unknown } = await changedSincePasses(path.join(RUNS_DIR, cmd.resume));
    if (changed.length > 0) {
      console.error(
        `Cannot resume ${cmd.resume}: files that change the measurement differ from the commit of an earlier pass:\n  ${changed.join("\n  ")}\nStart a new eval instead.`,
      );
      return 2;
    }
    if (unknown > 0) {
      console.warn(
        `Note: ${unknown} earlier pass(es) of ${cmd.resume} have no recorded factory commit; their comparability is not checked automatically.`,
      );
    }
  }
  const ids = taskIds.length > 0 ? taskIds : await listTaskIds();
  const tasks = [];
  for (const id of ids) tasks.push({ task: await loadTaskSpec(id), meta: await loadEvalMeta(id) });
  // Eval always starts from the immutable baseline tag of the eval stand (never a remote).
  const stand = await loadEvalStand();
  const repo = await ensureTargetRepo(stand.project, config.workdirAbs, "baseline");
  const { config: baselineProject } = await readProjectConfig(repo.dir, BASELINE_TAG);
  const exec = await defaultSandboxExec(repo.dir, sandboxProfile(baselineProject));
  const { runtime, runtimes } = runtimeDeps(config);
  const roles = Object.fromEntries(
    (["planner", "developer", "reviewer"] as const).map((r) => [
      r,
      `${config.roles[r].runtime}:${config.roles[r].model}`,
    ]),
  );

  const store = openStore(config);
  if (repo.baselineCreated && repo.baselineCommit) {
    store.recordBaseline({
      target: stand.project.id,
      tag: BASELINE_TAG,
      commitHash: repo.baselineCommit,
      actor: "factory",
      reason: "initial materialization",
    });
  }
  console.log(
    `Eval${cmd.resume ? ` ${cmd.resume} (resume)` : ""}: ${tasks.length} task(s) × ${repeat} repeat(s), sequential; cost cap $${costCapUsd}; factory ${commit}\n` +
      `roles: ${Object.entries(roles)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}`,
  );
  const evalIds = new Set<string>();
  if (cmd.resume) {
    if (store.getEval(cmd.resume)) store.resumeEval(cmd.resume);
    else
      store.createEval({
        id: cmd.resume,
        repeatCount: repeat,
        baselineCommit: repo.baseCommit,
        costCapUsd,
        projectId: stand.project.id,
      });
    evalIds.add(cmd.resume);
  }
  const { summary, summaryMdPath } = await runEvalRepeated(tasks, {
    repeat,
    roles,
    baselineCommit: repo.baseCommit,
    ...(cmd.resume ? { resumeEvalId: cmd.resume } : {}),
    factoryCommit: commit,
    runsDir: RUNS_DIR,
    runtimeName: [...new Set(Object.values(runtimes).map((r) => r.name))].join("+"),
    models: roles,
    costCapUsd,
    log: consoleLog,
    runTask: async (task, runsDir) => {
      // runs/eval-<ts>/r<N>/: the eval id is the parent directory, N the repeat.
      const evalId = path.basename(path.dirname(runsDir));
      const evalRepeat = Number(path.basename(runsDir).slice(1));
      if (!evalIds.has(evalId)) {
        evalIds.add(evalId);
        store.createEval({
          id: evalId,
          repeatCount: repeat,
          baselineCommit: repo.baseCommit,
          costCapUsd,
          projectId: stand.project.id,
        });
      }
      const outcome = await runTask(task, {
        config,
        runtime,
        runtimes,
        runsDir,
        store,
        project: stand.project,
        runContext: { mode: "eval", evalId, evalRepeat, baselineCommit: repo.baseCommit },
        makeSandboxExec: () => Promise.resolve(exec),
        log: consoleLog,
      });
      // Eval approves specs automatically and never merges: a successful run stops at the
      // merge gate with its report written.
      if (outcome.kind === "finished") return outcome;
      if (outcome.result) return outcome.result;
      throw new Error(`eval run paused at ${outcome.gate} approval`);
    },
    recordFirstPass: async (run, firstPass) => {
      // The database is the source of truth; the report files are refreshed to match.
      if (firstPass !== null) store.updateRun(run.report.runId, { firstPass });
      await writeFirstPass(run, firstPass);
    },
    runHidden: (worktreePath, taskId) =>
      runHiddenTests({
        worktreePath,
        taskId,
        exec,
        timeoutMs: config.stepTimeoutsMinutes.check * 60_000,
        hidden: stand.hidden,
      }),
  });
  for (const id of evalIds) {
    store.finishEval(id, {
      status: summary.interrupted
        ? "interrupted"
        : summary.costCapReached
          ? "cost_cap_reached"
          : "completed",
      repeatCount: summary.repeatsPlanned,
      costUsd: summary.repeats.reduce(
        (sum, r) => sum + r.metrics.totalCostUsd + r.replacedCostUsd,
        0,
      ),
      summaryPath: summaryMdPath,
    });
  }
  store.db.close();
  const m = summary.metrics;
  const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
  console.log(
    `\n${summary.repeatsDone}/${summary.repeatsPlanned} repeat(s): first pass ${pct(m.firstPassRate.mean)} ± ${pct(m.firstPassRate.stdev)}, ` +
      `verified ${pct(m.verifiedRate.mean)} ± ${pct(m.verifiedRate.stdev)}, ` +
      `false success ${pct(m.falseSuccessRate.mean)}, cycles gate ${m.avgGateFixCycles.mean ?? "n/a"} / review ${m.avgReviewCycles.mean ?? "n/a"}, ` +
      `time ${m.avgDurationSec.mean ?? "n/a"}s, cost/repeat $${(m.totalCostUsd.mean ?? 0).toFixed(2)}\n` +
      `summary: ${path.relative(process.cwd(), summaryMdPath)}`,
  );
  if (summary.interrupted) {
    console.log(
      `\nInterrupted: the model provider was unavailable. Continue later with:\n  npm run eval -- --resume ${summary.evalId}${cmd.costCapUsd ? ` --cost-cap ${String(cmd.costCapUsd)}` : ""}`,
    );
    return 3;
  }
  return summary.repeats.every((r) => r.metrics.hiddenLeaks === 0) ? 0 : 1;
}

/**
 * Re-judges a finished eval with the current hidden tests (no agent calls). Refuses to run with
 * uncommitted hidden tests, so a rescore always names the exact tests it used.
 */
async function evalRescore(evalId: string): Promise<number> {
  const evalDir = path.join(RUNS_DIR, evalId);
  const pending = (await git(FACTORY_ROOT, ["status", "--porcelain", "--", "evals/hidden"])).trim();
  if (pending) {
    console.error(`error: evals/hidden has uncommitted changes; commit them first:\n${pending}`);
    return 2;
  }
  const config = await loadConfig();
  const stand = await loadEvalStand();
  const repo = await ensureTargetRepo(stand.project, config.workdirAbs, "baseline");
  if (!repo.baselineCommit) throw new Error("the target has no factory-baseline tag");
  const baselineCommit = repo.baselineCommit;
  const { config: baselineProject } = await readProjectConfig(repo.dir, BASELINE_TAG);
  const exec = await defaultSandboxExec(repo.dir, sandboxProfile(baselineProject));
  const hiddenTestsCommit = await factoryCommit();
  console.log(
    `Rescore ${evalId}: stored diffs on ${BASELINE_TAG} ${baselineCommit.slice(0, 12)}, hidden tests at ${hiddenTestsCommit}`,
  );
  const { summary, changes, outDir } = await rescoreEval(evalDir, {
    baselineCommit,
    hiddenTestsCommit,
    materialize: (commit, dest) => exportTree(repo.dir, commit, dest),
    runHidden: (treeDir, taskId) =>
      runHiddenTests({
        worktreePath: treeDir,
        taskId,
        exec,
        timeoutMs: config.stepTimeoutsMinutes.check * 60_000,
        hidden: stand.hidden,
      }),
    log: consoleLog,
  });
  const store = openStore(config);
  try {
    if (repo.baselineCreated) {
      store.recordBaseline({
        target: stand.project.id,
        tag: BASELINE_TAG,
        commitHash: baselineCommit,
        actor: "factory",
        reason: "initial materialization",
      });
    }
    const id = `${evalId}-${path.basename(outDir)}`;
    store.createEval({
      id,
      repeatCount: summary.repeatsPlanned,
      baselineCommit,
      costCapUsd: null,
      projectId: stand.project.id,
      ...(store.getEval(evalId) ? { rescoreOf: evalId } : {}),
    });
    store.finishEval(id, {
      status: "completed",
      costUsd: 0,
      summaryPath: path.join(outDir, "summary.md"),
    });
  } finally {
    store.db.close();
  }
  const m = summary.metrics;
  const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
  const hiddenErrors = summary.repeats.reduce(
    (n, r) => n + r.tasks.filter((t) => t.outcome === "hidden_error").length,
    0,
  );
  console.log(
    `\nRescored ${summary.repeats.length} pass(es): first pass ${pct(m.firstPassRate.mean)} ± ${pct(m.firstPassRate.stdev)}, ` +
      `verified ${pct(m.verifiedRate.mean)} ± ${pct(m.verifiedRate.stdev)}, false success ${pct(m.falseSuccessRate.mean)} ± ${pct(m.falseSuccessRate.stdev)}\n` +
      `${changes.length} outcome change(s), ${hiddenErrors} hidden_error(s)\n` +
      `summary: ${path.relative(process.cwd(), path.join(outDir, "summary.md"))}`,
  );
  return hiddenErrors === 0 ? 0 : 1;
}

/** Is a registered project ready for the factory? (config, image, checks on clean main) */
async function projectCheck(projectId: string): Promise<number> {
  const config = await loadConfig();
  const project = await projectSourceFor(projectId, "interactive");
  console.log(`Project check: ${projectId}`);
  const lines = await checkProject(project, {
    ensureRepo: (p) => ensureTargetRepo(p, config.workdirAbs, "main"),
    sandbox: async (repoDir, profile) => {
      const tag = await ensureSandboxImage(repoDir, profile);
      return {
        tag,
        exec: (wt, command, timeoutMs) => runInSandbox(wt, command, timeoutMs, { image: tag }),
      };
    },
    checkTimeoutMs: config.stepTimeoutsMinutes.check * 60_000,
  });
  for (const l of lines) console.log(`${l.ok ? "PASS" : "FAIL"}  ${l.name.padEnd(16)} ${l.detail}`);
  const ok = lines.every((l) => l.ok);
  console.log(`\n${projectId}: ${ok ? "ready" : "NOT ready"}`);
  return ok ? 0 : 1;
}

/** The GitHub daemon (`npm run factory:watch`). */
async function watch(once: boolean, intervalOverride: number | null): Promise<number> {
  const config = await loadConfig();
  const token = process.env[config.github.tokenEnv];
  if (!token) {
    console.error(
      `error: ${config.github.tokenEnv} is not set. Put a fine-grained token (only the repositories in projects.yaml; Issues, Pull requests, Contents: read/write) into .env — see .env.example.`,
    );
    return 2;
  }
  const registry = await loadRegistry();
  const projects = registry.projects.filter((p) => p.github !== null);
  if (projects.length === 0) {
    console.error("error: no project in projects.yaml has a `github` repository");
    return 2;
  }
  const api = new GhCli({ token });
  const remote = ghRemote({ token });
  const store = openStore(config);
  let stop = false;
  let interrupts = 0;
  process.on("SIGINT", () => {
    interrupts++;
    if (interrupts > 1) {
      console.log(
        "\nSecond Ctrl+C: exiting now. Interrupted runs resume from their checkpoints on the next start.",
      );
      process.exit(130);
    }
    stop = true;
    console.log(
      "\nStopping: no new work is taken; the current step finishes and saves its checkpoint (Ctrl+C again to exit now).",
    );
  });
  try {
    const { runtime, runtimes } = runtimeDeps(config);
    const watcher = new Watcher({
      api,
      remote,
      store,
      projects,
      runDeps: () => ({ config, runtime, runtimes, runsDir: RUNS_DIR, store, log: consoleLog }),
      log: consoleLog,
      shouldStop: () => stop,
    });
    console.log(
      `factory:watch: ${projects.map((p) => `${p.id} (${p.github?.repo ?? ""})`).join(", ")}; every ${intervalOverride ?? config.github.pollIntervalSeconds}s${once ? ", once" : ""}`,
    );
    await runDaemon({
      store,
      watcher,
      rate: () => api.rate(),
      intervalSeconds: intervalOverride ?? config.github.pollIntervalSeconds,
      once,
      log: consoleLog,
      stopRequested: () => stop,
      sleep: (ms, stopped) =>
        new Promise((resolve) => {
          const until = Date.now() + ms;
          const tick = setInterval(() => {
            if (stopped() || Date.now() >= until) {
              clearInterval(tick);
              resolve();
            }
          }, 500);
        }),
    });
    return 0;
  } finally {
    store.db.close();
  }
}

async function resumeOne(runId: string): Promise<number> {
  const config = await loadConfig();
  const store = openStore(config);
  try {
    const { runtime, runtimes } = runtimeDeps(config);
    const run = store.requireRun(runId);
    const res = await resumeRun(runId, {
      config,
      runtime,
      runtimes,
      runsDir: RUNS_DIR,
      store,
      project: await projectSourceFor(run.project_id, run.mode),
      log: (m) => {
        console.log(m);
      },
    });
    if (res.kind === "awaiting_human") {
      console.log(
        `run ${runId} is waiting for a human decision (${res.run.status}); use ${res.run.status === "awaiting_merge_approval" ? "merge/close" : "approve/reject"}`,
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

async function listRuns(limit: number): Promise<number> {
  const store = openStore(await loadConfig());
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
  const store = openStore(await loadConfig());
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
    case "eval-rescore":
      return evalRescore(cmd.evalId);
    case "project-check":
      return projectCheck(cmd.projectId);
    case "watch":
      return watch(cmd.once, cmd.intervalSeconds);
    case "run":
      return runOne(cmd.projectId, cmd.task, cmd.autoApproveSpec);
    case "decide":
      return decideGate(cmd.runId, cmd.gate, cmd.decision, cmd.comment);
    case "baseline-update":
      return baselineUpdate(cmd.reason);
    case "reopen-merge":
      return reopenMerge(cmd.runId);
    case "eval-review":
      return evalReview(cmd.only);
    case "eval":
      return evalSuite(cmd);
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
