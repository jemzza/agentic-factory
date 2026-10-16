import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git } from "../git/git.js";
import { moveBaselineTag, type TargetRepo } from "../git/target-repo.js";
import type { SandboxExec } from "../quality/gate.js";
import { openDb } from "../store/db.js";
import { Store } from "../store/store.js";
import {
  appendingDeveloper,
  FAKE_APPROVE,
  FAKE_PLAN,
  FAKE_SPEC,
  FAKE_TASK,
  fakeConfig,
  fakeExec,
  fakeReviewer,
  FakeRuntime,
  makeFakeRepo,
} from "../testing/fakes.js";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { buildGraph } from "../workflow/graph.js";
import type { NodeFn } from "../workflow/nodes.js";
import { NODE_NAMES, type NodeName } from "../workflow/state.js";
import { reopenForMerge, resumeRun, runTask, type RunTaskDeps } from "./run-task.js";

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "factory-merge-test-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const head = async (dir: string, ref = "main") => (await git(dir, ["rev-parse", ref])).trim();
const commitOnMain = async (repo: TargetRepo, file: string, content: string) => {
  await mkdir(path.dirname(path.join(repo.dir, file)), { recursive: true });
  await writeFile(path.join(repo.dir, file), content);
  await git(repo.dir, ["add", "-A"]);
  await git(repo.dir, ["commit", "-q", "-m", `main: ${file}`]);
};

let n = 0;
/** A successful run waiting at the merge gate. */
async function successfulRun(exec: SandboxExec = fakeExec) {
  const base = path.join(tmp, `case-${++n}`);
  const repo = await makeFakeRepo(path.join(base, "repo"));
  const db = openDb(path.join(base, "factory.db"));
  const store = new Store(db);
  const runtime = new FakeRuntime({
    planner: () => Promise.resolve({ structured: FAKE_PLAN }),
    developer: appendingDeveloper(),
    reviewer: fakeReviewer(FAKE_APPROVE),
  });
  const deps: RunTaskDeps = {
    config: fakeConfig(path.join(base, "work")),
    runtime,
    runsDir: path.join(base, "runs"),
    store,
    ensureRepo: () => Promise.resolve(repo),
    makeSandboxExec: () => Promise.resolve(exec),
    specApprovalMode: "auto",
  };
  const outcome = await runTask(FAKE_TASK, deps);
  if (outcome.kind !== "awaiting" || outcome.gate !== "merge")
    throw new Error("expected the merge gate");
  return {
    repo,
    store,
    db,
    deps,
    runId: outcome.runId,
    baseline: await head(repo.dir, "factory-baseline"),
  };
}

/** What `npm run merge` / `npm run close` do. */
async function decide(
  ctx: Awaited<ReturnType<typeof successfulRun>>,
  decision: "merge" | "close",
  comment?: string,
) {
  ctx.store.recordApproval({
    runId: ctx.runId,
    gate: "merge",
    decision,
    actor: "tester",
    comment: comment ?? null,
  });
  return resumeRun(ctx.runId, ctx.deps, {
    answer: { decision, actor: "tester", ...(comment ? { comment } : {}) },
  });
}

describe("merge gate", () => {
  it("a successful run waits for a human; nothing is merged automatically", async () => {
    const c = await successfulRun();
    try {
      expect(c.store.requireRun(c.runId).status).toBe("awaiting_merge_approval");
      expect(await head(c.repo.dir)).toBe(c.repo.baseCommit);
      const notice = await readFile(
        path.join(c.deps.runsDir, c.runId, "merge-approval.md"),
        "utf8",
      );
      expect(notice).toContain(`npm run merge -- ${c.runId}`);
    } finally {
      c.db.close();
    }
  });

  it("merge: --no-ff commit with run id, task and report; spec archived in the same commit; baseline tag untouched", async () => {
    const c = await successfulRun();
    try {
      const res = await decide(c, "merge");
      expect(res.kind).toBe("resumed");
      const mergeCommit = await head(c.repo.dir);
      expect(c.store.requireRun(c.runId)).toMatchObject({ status: "merged" });
      // --no-ff: two parents, the first is the previous main.
      const parents = (await git(c.repo.dir, ["rev-list", "--parents", "-n", "1", mergeCommit]))
        .trim()
        .split(" ");
      expect(parents).toHaveLength(3);
      expect(parents[1]).toBe(c.repo.baseCommit);
      const message = await git(c.repo.dir, ["log", "-1", "--format=%B", mergeCommit]);
      expect(message).toContain(`Factory-Run: ${c.runId}`);
      expect(message).toContain(`Factory-Task: ${FAKE_TASK.id}`);
      expect(message).toContain(path.join(c.deps.runsDir, c.runId, "report.md"));
      // The archive is part of the merge commit itself.
      const files = (await git(c.repo.dir, ["ls-tree", "-r", "--name-only", mergeCommit])).split(
        "\n",
      );
      expect(files).toContain("src/feature.ts");
      expect(files).toContain("openspec/specs/feature-flags/spec.md");
      expect(
        files.some(
          (f) => f.startsWith(`openspec/changes/archive/`) && f.includes(`-${FAKE_TASK.id}/`),
        ),
      ).toBe(true);
      expect(files.some((f) => f.startsWith(`openspec/changes/${FAKE_TASK.id}/`))).toBe(false);
      // Merges never move the eval baseline.
      expect(await head(c.repo.dir, "factory-baseline")).toBe(c.baseline);
      // The gate ran on the merge result; the temporary worktree is gone.
      expect(
        c.store
          .listSteps(c.runId)
          .filter((s) => s.node === "merge_gate")
          .map((s) => s.status),
      ).toEqual(["ok"]);
      expect(await git(c.repo.dir, ["worktree", "list"])).not.toContain(`merge-${c.runId}`);
      expect(c.store.listApprovals(c.runId).map((a) => [a.gate, a.decision])).toEqual([
        ["spec", "approve"],
        ["merge", "merge"],
      ]);
    } finally {
      c.db.close();
    }
  });

  it("a second merge of the same run does nothing and reports the status", async () => {
    const c = await successfulRun();
    try {
      await decide(c, "merge");
      const mainAfter = await head(c.repo.dir);
      expect(await resumeRun(c.runId, c.deps)).toMatchObject({
        kind: "finished",
        run: { status: "merged" },
      });
      await expect(
        resumeRun(c.runId, c.deps, { answer: { decision: "merge", actor: "tester" } }),
      ).resolves.toMatchObject({ kind: "finished" });
      expect(await head(c.repo.dir)).toBe(mainAfter);
    } finally {
      c.db.close();
    }
  });

  it("refuses a merge answer for a run that is not waiting for one", async () => {
    const c = await successfulRun();
    try {
      await decide(c, "close", "not needed");
      expect(c.store.requireRun(c.runId)).toMatchObject({ status: "closed" });
      expect(await head(c.repo.dir)).toBe(c.repo.baseCommit);
      const res = await resumeRun(c.runId, c.deps, {
        answer: { decision: "merge", actor: "tester" },
      });
      expect(res).toMatchObject({ kind: "finished", run: { status: "closed" } });
      expect(await head(c.repo.dir)).toBe(c.repo.baseCommit);
    } finally {
      c.db.close();
    }
  });

  it("merges onto a main that moved ahead, and gates the merge result (not the branch)", async () => {
    const seen: string[][] = [];
    const exec: SandboxExec = async (wt, cmd, t) => {
      seen.push([
        wt,
        (await readFile(path.join(wt, "docs", "news.md"), "utf8").catch(() => "-")).trim(),
      ]);
      return fakeExec(wt, cmd, t);
    };
    const c = await successfulRun(exec);
    try {
      await commitOnMain(c.repo, "docs/news.md", "landed after the run started");
      const mainBefore = await head(c.repo.dir);
      seen.length = 0;
      await decide(c, "merge");
      expect(c.store.requireRun(c.runId).status).toBe("merged");
      const parents = (await git(c.repo.dir, ["rev-list", "--parents", "-n", "1", "main"]))
        .trim()
        .split(" ");
      expect(parents[1]).toBe(mainBefore);
      // Every gate check ran on the merge candidate, which contains main's new file.
      expect(seen.length).toBeGreaterThan(0);
      expect(
        seen.every(
          ([wt, news]) =>
            wt?.includes(`merge-${c.runId}`) && news === "landed after the run started",
        ),
      ).toBe(true);
    } finally {
      c.db.close();
    }
  });

  it("a conflict with main blocks the merge, leaves main untouched and waits for a human again", async () => {
    const c = await successfulRun();
    try {
      await commitOnMain(c.repo, "src/feature.ts", "export const feature = 'from main';\n");
      const mainBefore = await head(c.repo.dir);
      const res = await decide(c, "merge");
      expect(res).toMatchObject({ kind: "resumed", outcome: { kind: "awaiting", gate: "merge" } });
      const row = c.store.requireRun(c.runId);
      expect(row.status).toBe("awaiting_merge_approval");
      expect(row.status_message).toMatch(
        /merge conflicts with changes on main in: src\/feature\.ts/,
      );
      expect(await head(c.repo.dir)).toBe(mainBefore);
      expect((await git(c.repo.dir, ["status", "--porcelain"])).trim()).toBe("");
    } finally {
      c.db.close();
    }
  });

  it("a gate failure on the merge result blocks the merge", async () => {
    const exec: SandboxExec = async (wt, cmd, t) => {
      const broken = await readFile(path.join(wt, "src", "breaking.ts"), "utf8").catch(() => null);
      if (broken !== null && cmd.includes("test")) {
        return {
          exitCode: 1,
          stdout: "FAIL: breaking.ts conflicts with feature",
          stderr: "",
          durationMs: 1,
          timedOut: false,
        };
      }
      return fakeExec(wt, cmd, t);
    };
    const c = await successfulRun(exec);
    try {
      await commitOnMain(c.repo, "src/breaking.ts", "export const breaking = true;\n");
      const mainBefore = await head(c.repo.dir);
      await decide(c, "merge");
      const row = c.store.requireRun(c.runId);
      expect(row.status).toBe("awaiting_merge_approval");
      expect(row.status_message).toMatch(/quality gate failed on the merge result/);
      expect(await head(c.repo.dir)).toBe(mainBefore);
      expect(
        c.store
          .listSteps(c.runId)
          .filter((s) => s.node === "merge_gate")
          .map((s) => s.status),
      ).toEqual(["failed"]);
    } finally {
      c.db.close();
    }
  });

  it("only the explicit baseline update moves the tag", async () => {
    const c = await successfulRun();
    try {
      await decide(c, "merge");
      expect(await head(c.repo.dir, "factory-baseline")).toBe(c.baseline);
      const moved = await moveBaselineTag(c.repo.dir);
      expect(moved).toEqual({ previous: c.baseline, current: await head(c.repo.dir) });
      expect(await head(c.repo.dir, "factory-baseline")).toBe(await head(c.repo.dir));
      expect(await moveBaselineTag(c.repo.dir)).toEqual({
        previous: moved.current,
        current: moved.current,
      });
    } finally {
      c.db.close();
    }
  });

  it("reopen-merge puts a success run from before the merge gate at the gate; then merge works", async () => {
    const c = await successfulRun();
    try {
      // Simulate a pre-Phase-5 run: checkpoint finished right after `report` (no merge gate).
      const noop: NodeFn = () => Promise.resolve({});
      const nodes = Object.fromEntries(NODE_NAMES.map((name) => [name, noop])) as Record<
        NodeName,
        NodeFn
      >;
      const legacy = buildGraph(nodes, {
        deadlineNow: () => Date.now(),
        checkpointer: new SqliteSaver(c.db),
      });
      // Its spec predates the `source` rule — in the checkpoint and in report.json.
      const oldSpec = structuredClone(FAKE_SPEC) as {
        capabilities: { requirements: { source?: string }[] }[];
      };
      for (const cap of oldSpec.capabilities) for (const r of cap.requirements) delete r.source;
      await legacy.updateState(
        { configurable: { thread_id: c.runId } },
        { spec: oldSpec },
        "close",
      );
      c.store.updateRun(c.runId, { status: "success" });
      const reportJson = path.join(c.deps.runsDir, c.runId, "report.json");
      const report = JSON.parse(await readFile(reportJson, "utf8")) as {
        spec: { change: unknown };
      };
      report.spec.change = oldSpec;
      await writeFile(reportJson, JSON.stringify(report));
      expect((await legacy.getState({ configurable: { thread_id: c.runId } })).next).toEqual([]);

      const reopened = await reopenForMerge(c.runId, c.deps, "tester");
      expect(reopened).toMatchObject({ kind: "awaiting", gate: "merge" });
      expect(c.store.requireRun(c.runId).status).toBe("awaiting_merge_approval");
      const migration = c.store
        .listEvents(c.runId)
        .find((e) => e.kind === "transition" && (e.payload ?? "").includes("reopen-merge"));
      expect(migration).toMatchObject({ node: "report", next: "merge_approval" });

      await decide(c, "merge");
      expect(c.store.requireRun(c.runId).status).toBe("merged");
      expect(await head(c.repo.dir, "factory-baseline")).toBe(c.baseline);
    } finally {
      c.db.close();
    }
  });

  it("reopen-merge refuses runs that are not a finished success at the report", async () => {
    const waiting = await successfulRun();
    try {
      // Already at the merge gate.
      await expect(reopenForMerge(waiting.runId, waiting.deps, "tester")).rejects.toThrow(
        /only a finished "success" run/,
      );
      await decide(waiting, "close", "no");
      // Closed run: status closed.
      await expect(reopenForMerge(waiting.runId, waiting.deps, "tester")).rejects.toThrow(
        /status closed/,
      );
      // Even if someone flips the DB status, the checkpoint did not end at the report.
      waiting.store.updateRun(waiting.runId, { status: "success" });
      await expect(reopenForMerge(waiting.runId, waiting.deps, "tester")).rejects.toThrow(
        /did not end at a successful report/,
      );
    } finally {
      waiting.db.close();
    }
  });
});
