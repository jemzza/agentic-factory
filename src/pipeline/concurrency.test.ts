import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  runEval,
  type EvalRunOutcome,
  type EvalSummary,
  type EvalTaskInput,
  type RunControl,
} from "../eval/run-eval.js";
import { git } from "../git/git.js";
import { runCommand } from "../process/run-command.js";
import type { AgentRunInput } from "../runtimes/types.js";
import { openDb } from "../store/db.js";
import { Store } from "../store/store.js";
import {
  appendingDeveloper,
  FAKE_APPROVE,
  FAKE_PLAN,
  FAKE_PROJECT,
  FAKE_TASK,
  fakeConfig,
  fakeExec,
  fakePlanner,
  fakeReviewer,
  FakeRuntime,
  makeFakeRepo,
  resultOf,
  type FakeScript,
} from "../testing/fakes.js";
import { CostPool } from "./cost-pool.js";
import { resumeRun, runTask, type RunOutcome, type RunTaskDeps } from "./run-task.js";

/*
 * Parallel runs (Week 3 Phase 4), with fake agents and the real pipeline, git, SQLite and
 * checkpoints. No network, no Docker.
 */

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "workflow",
  "__fixtures__",
  "crash-pool.ts",
);
const LINE = "export const feature = 1;\n";
let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "factory-concurrency-test-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;

async function evalSetup(script: FakeScript) {
  const base = path.join(tmp, `case-${++n}`);
  const repo = await makeFakeRepo(path.join(base, "repo"));
  const store = new Store(openDb(path.join(base, "factory.db")));
  const runtime = new FakeRuntime(script);
  const deps = (runsDir: string, ctl: RunControl): RunTaskDeps => ({
    config: fakeConfig(path.join(base, "work")),
    runtime,
    runsDir,
    store,
    project: FAKE_PROJECT,
    ensureRepo: () => Promise.resolve(repo),
    makeSandboxExec: () => Promise.resolve(fakeExec),
    specApprovalMode: "auto",
    pauseReason: ctl.pauseReason,
    costPool: ctl.costPool,
  });
  const outcome = (o: RunOutcome): EvalRunOutcome =>
    o.kind === "paused"
      ? {
          kind: "paused",
          runId: o.runId,
          reason: o.reason,
          spentUsd: store.requireRun(o.runId).cost_usd,
        }
      : { kind: "done", result: resultOf(o) };
  const tasks = (count: number): EvalTaskInput[] =>
    Array.from({ length: count }, (_, i) => ({
      task: { ...FAKE_TASK, id: `task-${String(i + 1).padStart(2, "0")}` },
      meta: { difficulty: "simple", expected_outcome: "implemented", traps: [] },
    }));
  const evalDeps = {
    runsDir: base,
    runtimeName: "fake",
    models: {},
    runTask: async (task: EvalTaskInput["task"], runsDir: string, ctl: RunControl) =>
      outcome(await runTask(task, deps(runsDir, ctl), { runId: ctl.runId })),
    resumeTask: async (runId: string, runsDir: string, ctl: RunControl) => {
      const res = await resumeRun(runId, deps(runsDir, ctl));
      if (res.kind !== "resumed") throw new Error(`could not resume ${runId}: ${res.kind}`);
      return outcome(res.outcome);
    },
    runHidden: () =>
      Promise.resolve({
        passed: true,
        exitCode: 0,
        timedOut: false,
        total: 1,
        failed: 0,
        durationMs: 1,
        outputTail: "",
      }),
  };
  return { base, repo, store, runtime, tasks, evalDeps };
}

/** Tracks how many calls of a role run at once. */
function concurrencyMeter() {
  let now = 0;
  let max = 0;
  return {
    wrap:
      <T>(fn: (input: AgentRunInput, i: number) => Promise<T>) =>
      async (input: AgentRunInput, i: number) => {
        now++;
        max = Math.max(max, now);
        try {
          await sleep(15);
          return await fn(input, i);
        } finally {
          now--;
        }
      },
    max: () => max,
  };
}

describe("parallel eval (--concurrency)", () => {
  it("runs tasks in parallel on one project without git or SQLite conflicts", async () => {
    const meter = concurrencyMeter();
    const t = await evalSetup({
      planner: meter.wrap(fakePlanner()),
      developer: meter.wrap(appendingDeveloper()),
      reviewer: meter.wrap(fakeReviewer(FAKE_APPROVE)),
    });
    const { summary } = await runEval(t.tasks(8), { ...t.evalDeps, concurrency: 4 });
    expect(summary.tasks.map((r) => r.outcome)).toEqual(Array(8).fill("verified"));
    expect(summary.tasks.map((r) => r.taskId)).toEqual(t.tasks(8).map((x) => x.task.id)); // task order kept
    expect(meter.max()).toBeGreaterThan(1);
    expect(meter.max()).toBeLessThanOrEqual(4);
    expect((await git(t.repo.dir, ["fsck", "--no-progress"])).trim()).toBe("");
    const branches = (await git(t.repo.dir, ["branch", "--list", "factory/*"])).trim().split("\n");
    expect(branches).toHaveLength(8);
    t.store.db.close();
  });

  it("never lets parallel runs spend more than the shared cost cap", async () => {
    // Every agent call spends what it was allowed (its reservation), up to $0.30.
    const spend = (input: AgentRunInput) => Math.min(0.3, input.maxBudgetUsd ?? 0.3);
    const allowed: number[] = [];
    const t = await evalSetup({
      planner: (input) => {
        allowed.push(input.maxBudgetUsd ?? 0);
        return sleep(5).then(() => ({ structured: FAKE_PLAN, costUsd: spend(input) }));
      },
      developer: async (input) => {
        allowed.push(input.maxBudgetUsd ?? 0);
        await appendingDeveloper()(input);
        return { costUsd: spend(input) };
      },
      reviewer: (input) => {
        allowed.push(input.maxBudgetUsd ?? 0);
        return Promise.resolve({ structured: FAKE_APPROVE, costUsd: spend(input) });
      },
    });
    const cap = 2.0;
    const { summary } = await runEval(t.tasks(10), {
      ...t.evalDeps,
      concurrency: 4,
      costCapUsd: cap,
    });
    const spent =
      summary.tasks.reduce((s, r) => s + r.costUsd, 0) +
      summary.pausedRuns.reduce((s, p) => s + p.spentUsd, 0);
    expect(spent).toBeLessThanOrEqual(cap + 1e-9);
    expect(summary.costCap?.reached).toBe(true);
    expect(
      summary.tasks.length +
        summary.pausedRuns.length +
        (summary.costCap?.skippedTasks.length ?? 0),
    ).toBe(10);
    expect(allowed.every((a) => a > 0)).toBe(true);
    t.store.db.close();
  });

  it("after an infra_error no new task starts, running ones pause, and --resume finishes them", async () => {
    let started = 0;
    let providerBack = false;
    const t = await evalSetup({
      planner: async (input) => {
        started++;
        // task-03 hits the provider limit; the others are still working when it does.
        if (!providerBack && input.prompt.includes("task-03")) {
          return {
            ok: false,
            error: { kind: "infra" as const, message: "You've hit your session limit" },
          };
        }
        await sleep(40);
        return { structured: FAKE_PLAN };
      },
      developer: async (input) => {
        await sleep(40);
        return appendingDeveloper()(input);
      },
      reviewer: fakeReviewer(FAKE_APPROVE),
    });
    const first = await runEval(t.tasks(8), { ...t.evalDeps, concurrency: 3 });
    const s1: EvalSummary = first.summary;
    expect(s1.interrupted).not.toBeNull();
    expect(s1.tasks.find((r) => r.taskId === "task-03")?.outcome).toBe("infra_error");
    expect(started).toBeLessThanOrEqual(3); // nothing started after the infra_error
    expect(s1.pausedRuns.map((p) => p.taskId).sort()).toEqual(["task-01", "task-02"]);
    for (const p of s1.pausedRuns)
      expect(t.store.requireRun(p.runId).status_message).toMatch(/^paused:/);

    // The provider is back: resume. Paused runs continue from their checkpoints (no new plan).
    providerBack = true;
    const plannerCallsBefore = t.runtime.calls.filter((c) => c.role === "planner").length;
    // A paused run stops at a node boundary: usually after its plan, but under heavy load it can
    // pause before planning (then planning it on resume is correct). What must never happen is
    // planning a run twice.
    const plannedBeforePause = s1.pausedRuns.filter((p) =>
      t.store.listSteps(p.runId).some((st) => st.node === "planner" && st.status === "ok"),
    ).length;
    const second = await runEval(t.tasks(8), {
      ...t.evalDeps,
      concurrency: 3,
      previous: s1,
      evalId: s1.evalId,
      evalDir: path.join(t.base, s1.evalId),
    });
    expect(second.summary.interrupted).toBeNull();
    expect(second.summary.tasks.map((r) => r.outcome)).toEqual(Array(8).fill("verified"));
    const newPlans =
      t.runtime.calls.filter((c) => c.role === "planner").length - plannerCallsBefore;
    expect(newPlans).toBe(8 - plannedBeforePause); // runs planned before the pause are not planned again
    for (const p of s1.pausedRuns) {
      expect(second.summary.tasks.find((r) => r.taskId === p.taskId)?.reportPath).toContain(
        p.runId,
      );
    }
    t.store.db.close();
  });
});

describe("CostPool", () => {
  it("reserves atomically, waits for open reservations, refuses when the cap is spent", async () => {
    const pool = new CostPool(1.0);
    const a = await pool.reserve(0.6, "r1");
    const b = await pool.reserve(0.6, "r2");
    expect(a).toMatchObject({ ok: true, amountUsd: 0.6 });
    expect(b).toMatchObject({ ok: true, amountUsd: 0.4 }); // only what is left
    let cResolved = false;
    const c = pool.reserve(0.5, "r3").then((r) => {
      cResolved = true;
      return r;
    });
    await sleep(5);
    expect(cResolved).toBe(false); // waits: everything is reserved
    if (a.ok) pool.settle(a.id, 0.2); // a spent less than reserved
    expect(await c).toMatchObject({ ok: true, amountUsd: 0.4 });
    if (b.ok) pool.settle(b.id, 0.4);
    expect(pool.spentBy("r2")).toBeCloseTo(0.4);
    expect(pool.reservedUsd()).toBeCloseTo(0.4); // c's reservation is still open
    const cr = await c;
    if (cr.ok) pool.settle(cr.id, 0.4);
    // 0.2 + 0.4 + 0.4 spent, nothing reserved: refused instead of waiting forever.
    expect(await pool.reserve(0.5)).toMatchObject({ ok: false });
    expect(pool.exhausted()).toBe(true);
  });
});

describe("crash with four runs in flight", () => {
  it("resume completes every run with no duplicated changes", async () => {
    const base = path.join(tmp, "kill-4");
    const repo = await makeFakeRepo(path.join(base, "repo"));
    const runIds = [1, 2, 3, 4].map((i) => `20261020-120000-000${i}`);
    const args = {
      dbPath: path.join(base, "factory.db"),
      workdir: path.join(base, "work"),
      runsDir: path.join(base, "runs"),
      repoDir: repo.dir,
      baseCommit: repo.baseCommit,
      runIds,
      line: LINE,
    };
    const child = await runCommand(
      process.execPath,
      ["--import", "tsx", FIXTURE, JSON.stringify(args)],
      {
        cwd: process.cwd(),
        timeoutMs: 60_000,
      },
    );
    expect(child.exitCode).toBeNull(); // killed by SIGKILL
    const store = new Store(openDb(args.dbPath));
    for (const id of runIds) {
      expect(store.listSteps(id).at(-1)).toMatchObject({ node: "developer", status: "running" });
    }
    const runtime = new FakeRuntime({
      planner: fakePlanner(),
      developer: appendingDeveloper(LINE),
      reviewer: fakeReviewer(FAKE_APPROVE),
    });
    const deps: RunTaskDeps = {
      config: fakeConfig(args.workdir),
      runtime,
      runsDir: args.runsDir,
      store,
      project: FAKE_PROJECT,
      ensureRepo: () => Promise.resolve(repo),
      makeSandboxExec: () => Promise.resolve(fakeExec),
      specApprovalMode: "auto",
    };
    // All four resumed at once.
    const results = await Promise.all(runIds.map((id) => resumeRun(id, deps)));
    for (const [i, res] of results.entries()) {
      if (res.kind !== "resumed") throw new Error(`run ${runIds[i] ?? ""} not resumed`);
      const report = resultOf(res.outcome).report;
      expect(report.status).toBe("success");
      const wt = store.requireRun(runIds[i] ?? "").worktree_path ?? "";
      expect(await readFile(path.join(wt, "src", "feature.ts"), "utf8")).toBe(LINE);
      expect(report.diff.split("+export const feature = 1;").length - 1).toBe(1);
    }
    expect(runtime.rolesCalled().filter((r) => r === "planner")).toEqual([]);
    expect((await git(repo.dir, ["fsck", "--no-progress"])).trim()).toBe("");
    store.db.close();
  });
});
