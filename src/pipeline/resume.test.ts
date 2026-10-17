import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git } from "../git/git.js";
import { runCommand } from "../process/run-command.js";
import { openDb } from "../store/db.js";
import { Store } from "../store/store.js";
import {
  appendingDeveloper,
  FAKE_APPROVE,
  FAKE_REJECT,
  fakeConfig,
  fakeExec,
  fakePlanner,
  fakeReviewer,
  FakeRuntime,
  makeFakeRepo,
  resultOf,
} from "../testing/fakes.js";
import { resumeRun, type RunTaskDeps } from "./run-task.js";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "workflow",
  "__fixtures__",
  "crash-run.ts",
);
const LINE = "export const feature = 1;\n";

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "factory-resume-test-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

let n = 0;
/** Starts a run in a child process that SIGKILLs itself inside `crashIn`. */
async function crashRun(crashIn: "develop" | "gate" | "gate-after-review-fix") {
  const base = path.join(tmp, `case-${++n}`);
  const repo = await makeFakeRepo(path.join(base, "repo"));
  const args = {
    crashIn,
    dbPath: path.join(base, "factory.db"),
    workdir: path.join(base, "work"),
    runsDir: path.join(base, "runs"),
    repoDir: repo.dir,
    baseCommit: repo.baseCommit,
    runId: `20261015-120000-${String(n).padStart(4, "0")}`,
  };
  const child = await runCommand(
    process.execPath,
    ["--import", "tsx", FIXTURE, JSON.stringify(args)],
    {
      cwd: process.cwd(),
      timeoutMs: 60_000,
    },
  );
  return { ...args, repo, child };
}

function resumeDeps(
  a: Awaited<ReturnType<typeof crashRun>>,
  store: Store,
  runtime: FakeRuntime,
): RunTaskDeps {
  return {
    config: fakeConfig(a.workdir),
    runtime,
    runsDir: a.runsDir,
    store,
    ensureRepo: () => Promise.resolve(a.repo),
    makeSandboxExec: () => Promise.resolve(fakeExec),
    specApprovalMode: "auto",
  };
}

const goodRuntime = () =>
  new FakeRuntime({
    planner: fakePlanner(),
    developer: appendingDeveloper(LINE),
    reviewer: fakeReviewer(FAKE_APPROVE),
  });

describe("resume after a crash", () => {
  it("killed during develop → resume → completes; the diff has no duplicated changes", async () => {
    const a = await crashRun("develop");
    expect(a.child.exitCode).toBeNull(); // killed by a signal, not a normal exit
    const db = openDb(a.dbPath);
    const store = new Store(db);
    try {
      const before = store.requireRun(a.runId);
      expect(before.status).toBe("running");
      expect(store.listSteps(a.runId).at(-1)).toMatchObject({
        node: "developer",
        status: "running",
      });

      // The crashed attempt left a partial change in the worktree.
      const wtPath = before.worktree_path ?? "";
      expect(await readFile(path.join(wtPath, "src", "feature.ts"), "utf8")).toBe(LINE);

      const runtime = goodRuntime();
      const res = await resumeRun(a.runId, resumeDeps(a, store, runtime));
      if (res.kind !== "resumed") throw new Error("expected a resumed run");
      const report = resultOf(res.outcome).report;
      expect(report.status).toBe("success");
      // Planner was checkpointed before the crash: only develop onwards ran again.
      expect(runtime.rolesCalled()).toEqual(["developer", "reviewer"]);
      // Exactly one copy of the change, both on disk and in the diff.
      expect(await readFile(path.join(wtPath, "src", "feature.ts"), "utf8")).toBe(LINE);
      expect(report.diff.split("+export const feature = 1;").length - 1).toBe(1);
      expect(report.changedFiles.filter((f) => !f.startsWith("openspec/"))).toEqual([
        "src/feature.ts",
      ]);
      // The abandoned attempt is visible and its cost is counted as unknown.
      expect(
        store
          .listSteps(a.runId)
          .filter((s) => s.node === "developer")
          .map((s) => [s.attempt, s.status]),
      ).toEqual([
        [1, "abandoned"],
        [2, "ok"],
      ]);
      expect(report.cost.unknownCostSteps).toBe(1);
      expect(store.requireRun(a.runId)).toMatchObject({
        status: "awaiting_merge_approval",
        locked_by: null,
      });
      expect(store.listEvents(a.runId).some((e) => e.kind === "resume")).toBe(true);
      // The worktree is clean at the final snapshot.
      expect((await git(wtPath, ["status", "--porcelain"])).trim()).toBe("");
    } finally {
      db.close();
    }
  }, 120_000);

  it("killed during gate → resume → the gate runs again and the result is correct", async () => {
    const a = await crashRun("gate");
    expect(a.child.exitCode).toBeNull();
    const db = openDb(a.dbPath);
    const store = new Store(db);
    try {
      expect(store.listSteps(a.runId).at(-1)).toMatchObject({ node: "gate", status: "running" });
      const runtime = goodRuntime();
      const res = await resumeRun(a.runId, resumeDeps(a, store, runtime));
      if (res.kind !== "resumed") throw new Error("expected a resumed run");
      const result = resultOf(res.outcome);
      expect(result.report.status).toBe("success");
      expect(result.report.gate?.passed).toBe(true);
      // develop had completed before the crash: it is not repeated.
      expect(runtime.rolesCalled()).toEqual(["reviewer"]);
      expect(
        store
          .listSteps(a.runId)
          .filter((s) => s.node === "gate")
          .map((s) => [s.attempt, s.status]),
      ).toEqual([
        [1, "abandoned"],
        [2, "ok"],
      ]);
      expect(result.report.diff.split("+export const feature = 1;").length - 1).toBe(1);
    } finally {
      db.close();
    }
  }, 120_000);

  it("killed after the first review rework → resume → reviewCycles = 1 restored, no extra rework", async () => {
    const a = await crashRun("gate-after-review-fix");
    expect(a.child.exitCode).toBeNull();
    const db = openDb(a.dbPath);
    const store = new Store(db);
    try {
      // Before the crash: one review rework, then killed inside the following gate.
      expect(store.requireRun(a.runId)).toMatchObject({ review_cycles: 1, gate_fix_cycles: 0 });
      expect(store.listSteps(a.runId).at(-1)).toMatchObject({ node: "gate", status: "running" });

      // The reviewer still requests changes. With max_review_cycles = 1 already spent, the
      // restored counter must end the run; a counter reset to 0 would call the developer again.
      const runtime = new FakeRuntime({
        planner: fakePlanner(),
        developer: appendingDeveloper(LINE),
        reviewer: fakeReviewer(FAKE_REJECT),
      });
      const res = await resumeRun(a.runId, resumeDeps(a, store, runtime));
      if (res.kind !== "resumed") throw new Error("expected a resumed run");
      const report = resultOf(res.outcome).report;
      expect(report.status).toBe("review_rejected");
      expect(report.message).toContain("after 1 of 1 review cycle(s)");
      expect(runtime.rolesCalled()).toEqual(["reviewer"]);
      expect(store.requireRun(a.runId)).toMatchObject({
        status: "review_rejected",
        review_cycles: 1,
        gate_fix_cycles: 0,
        fix_cycles: 1,
      });
    } finally {
      db.close();
    }
  }, 120_000);

  it("resuming a finished run does nothing and reports its status", async () => {
    const a = await crashRun("gate");
    const db = openDb(a.dbPath);
    const store = new Store(db);
    try {
      const first = await resumeRun(a.runId, resumeDeps(a, store, goodRuntime()));
      expect(first.kind).toBe("resumed");
      // A plain resume while waiting for the merge decision does nothing either.
      expect(await resumeRun(a.runId, resumeDeps(a, store, goodRuntime()))).toMatchObject({
        kind: "awaiting_human",
        run: { status: "awaiting_merge_approval" },
      });
      // Close it, then a resume of the finished run is a no-op that reports the status.
      const closed = await resumeRun(a.runId, resumeDeps(a, store, goodRuntime()), {
        answer: { decision: "close", actor: "tester", comment: "not needed" },
      });
      expect(closed.kind).toBe("resumed");
      const eventsBefore = store.listEvents(a.runId).length;
      const stepsBefore = store.listSteps(a.runId).length;

      const runtime = goodRuntime();
      const again = await resumeRun(a.runId, resumeDeps(a, store, runtime));
      expect(again).toMatchObject({ kind: "finished", run: { status: "closed" } });
      expect(runtime.calls).toHaveLength(0);
      expect(store.listEvents(a.runId)).toHaveLength(eventsBefore);
      expect(store.listSteps(a.runId)).toHaveLength(stepsBefore);
    } finally {
      db.close();
    }
  }, 120_000);
});
