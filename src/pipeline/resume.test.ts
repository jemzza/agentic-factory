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
  fakeConfig,
  fakeExec,
  fakePlanner,
  fakeReviewer,
  FakeRuntime,
  makeFakeRepo,
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
async function crashRun(crashIn: "develop" | "gate") {
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
      if (res.kind !== "resumed" || res.outcome.kind !== "finished")
        throw new Error("expected a finished run");
      const report = res.outcome.report;
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
      expect(store.requireRun(a.runId)).toMatchObject({ status: "success", locked_by: null });
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
      if (res.kind !== "resumed" || res.outcome.kind !== "finished")
        throw new Error("expected a finished run");
      expect(res.outcome.report.status).toBe("success");
      expect(res.outcome.report.gate?.passed).toBe(true);
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
      expect(res.outcome.report.diff.split("+export const feature = 1;").length - 1).toBe(1);
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
      const eventsBefore = store.listEvents(a.runId).length;
      const stepsBefore = store.listSteps(a.runId).length;

      const runtime = goodRuntime();
      const again = await resumeRun(a.runId, resumeDeps(a, store, runtime));
      expect(again).toMatchObject({ kind: "finished", run: { status: "success" } });
      expect(runtime.calls).toHaveLength(0);
      expect(store.listEvents(a.runId)).toHaveLength(eventsBefore);
      expect(store.listSteps(a.runId)).toHaveLength(stepsBefore);
    } finally {
      db.close();
    }
  }, 120_000);
});
