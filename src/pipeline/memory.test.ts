import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prBody } from "../github/render.js";
import { InMemoryMemory } from "../memory/in-memory.js";
import type { MemoryAccess } from "../memory/runtime.js";
import { openDb } from "../store/db.js";
import { Store } from "../store/store.js";
import {
  appendingDeveloper,
  FAKE_APPROVE,
  FAKE_PLAN,
  FAKE_PROJECT,
  FAKE_REJECT,
  FAKE_TASK,
  fakeConfig,
  fakeExec,
  fakeReviewer,
  FakeRuntime,
  makeFakeRepo,
  resultOf,
  type FakeScript,
} from "../testing/fakes.js";
import { resumeRun, runTask, type RunTaskDeps } from "./run-task.js";

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "factory-memory-pipeline-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

let n = 0;
async function setup(
  script: FakeScript,
  memory: MemoryAccess | undefined,
  approval: "auto" | "manual" = "auto",
) {
  const base = path.join(tmp, `case-${++n}`);
  const repo = await makeFakeRepo(path.join(base, "repo"));
  const store = new Store(openDb(path.join(base, "factory.db")));
  const runtime = new FakeRuntime(script);
  const deps: RunTaskDeps = {
    config: fakeConfig(path.join(base, "work")),
    runtime,
    runsDir: path.join(base, "runs"),
    store,
    project: FAKE_PROJECT,
    ensureRepo: () => Promise.resolve(repo),
    makeSandboxExec: () => Promise.resolve(fakeExec),
    specApprovalMode: approval,
    ...(memory ? { memory } : {}),
  };
  return { store, runtime, deps };
}

const access = (
  memory: InMemoryMemory | null,
  extra: Partial<MemoryAccess> = {},
): MemoryAccess => ({
  memory,
  unavailable: memory ? null : "Ollama is not reachable at http://127.0.0.1:11434",
  limit: 5,
  required: false,
  ...extra,
});

describe("project memory in runs", () => {
  it("gives the planner this project's knowledge, with its source, and lists it in the report", async () => {
    const mem = new InMemoryMemory();
    await mem.add("t", {
      text: "Feature modules export a feature constant and have a test.",
      source: "manual",
      runId: null,
      origin: { kind: "cli" },
    });
    await mem.add("other", {
      text: "Feature flags in the other project are YAML.",
      source: "manual",
      runId: null,
      origin: { kind: "cli" },
    });
    const t = await setup(
      {
        planner: () => Promise.resolve({ structured: FAKE_PLAN }),
        developer: appendingDeveloper(),
        reviewer: fakeReviewer(FAKE_APPROVE),
      },
      access(mem),
    );
    const report = resultOf(await runTask(FAKE_TASK, t.deps)).report;
    const prompt = t.runtime.calls[0]?.prompt ?? "";
    expect(prompt).toContain("## Project knowledge (from earlier runs of this project)");
    expect(prompt).toContain(
      "- Feature modules export a feature constant and have a test. (source: manual)",
    );
    expect(prompt).not.toContain("other project");
    expect(report.memory).toMatchObject({ status: "used", used: [{ source: "manual" }] });
    expect(prBody({ report, issue: 1, specHashValue: null })).toContain("## Project memory");
  });

  it("stores the planner's lesson from a human rejection only once the revised spec is approved", async () => {
    const mem = new InMemoryMemory();
    let plans = 0;
    const t = await setup(
      {
        planner: () => {
          plans++;
          const lessons =
            plans > 1 ? ["Feature modules always come with a test of the error path."] : [];
          return Promise.resolve({ structured: { ...FAKE_PLAN, lessons } });
        },
        developer: appendingDeveloper(),
        reviewer: fakeReviewer(FAKE_APPROVE),
      },
      access(mem),
      "manual",
    );
    const first = await runTask(FAKE_TASK, t.deps);
    if (first.kind !== "awaiting") throw new Error("expected the spec gate");
    t.store.recordApproval({
      runId: first.runId,
      gate: "spec",
      decision: "reject",
      actor: "alice",
      comment: "Also test the error path.",
    });
    await resumeRun(first.runId, t.deps, {
      answer: { decision: "reject", actor: "alice", comment: "Also test the error path." },
    });
    expect(await mem.list("t")).toEqual([]); // rejected, not yet confirmed
    t.store.recordApproval({
      runId: first.runId,
      gate: "spec",
      decision: "approve",
      actor: "alice",
    });
    const done = await resumeRun(first.runId, t.deps, {
      answer: { decision: "approve", actor: "alice" },
    });
    if (done.kind !== "resumed") throw new Error("expected a resumed run");
    const records = await mem.list("t");
    expect(records).toMatchObject([
      {
        text: "Feature modules always come with a test of the error path.",
        source: "spec_rejection_comment",
        runId: first.runId,
      },
    ]);
    expect(resultOf(done.outcome).report.memory?.written).toEqual([records[0]?.id]);
  });

  it("stores a reviewer finding once its fix passed the gate and the review", async () => {
    const mem = new InMemoryMemory();
    const t = await setup(
      {
        planner: () => Promise.resolve({ structured: FAKE_PLAN }),
        developer: appendingDeveloper(),
        reviewer: fakeReviewer(FAKE_REJECT, FAKE_APPROVE),
      },
      access(mem),
    );
    const report = resultOf(await runTask(FAKE_TASK, t.deps)).report;
    expect(report.status).toBe("success");
    expect((await mem.list("t")).map((r) => [r.source, r.text])).toEqual([
      ["review_issue_fixed", "no edge case"],
    ]);
  });

  it("an ordinary run goes on without memory when it is unavailable, and says so", async () => {
    const t = await setup(
      {
        planner: () => Promise.resolve({ structured: FAKE_PLAN }),
        developer: appendingDeveloper(),
        reviewer: fakeReviewer(FAKE_APPROVE),
      },
      access(null),
    );
    const report = resultOf(await runTask(FAKE_TASK, t.deps)).report;
    expect(report.status).toBe("success");
    expect(report.memory?.status).toBe("unavailable");
    expect(report.memory?.note).toContain("Ollama is not reachable");
    expect(t.runtime.calls[0]?.prompt).not.toContain("Project knowledge");
    expect(prBody({ report, issue: 1, specHashValue: null })).toContain("**Memory unavailable**");
  });

  it("a run that requires memory (eval:memory, memory_on) ends infra_error instead of running without it", async () => {
    const t = await setup(
      {
        planner: () => Promise.resolve({ structured: FAKE_PLAN }),
        developer: appendingDeveloper(),
        reviewer: fakeReviewer(FAKE_APPROVE),
      },
      access(null, { required: true }),
    );
    const report = resultOf(await runTask(FAKE_TASK, t.deps)).report;
    expect(report.status).toBe("infra_error");
    expect(report.message).toMatch(/project memory unavailable/);
    expect(t.runtime.calls).toEqual([]); // not even the planner ran
  });
});
