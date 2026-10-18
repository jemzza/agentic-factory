import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryMemory } from "../memory/in-memory.js";
import type { MemoryAccess } from "../memory/runtime.js";
import type { RunTaskResult } from "../pipeline/run-task.js";
import type { RunReport } from "../schemas/report.js";
import { FAKE_TASK } from "../testing/fakes.js";
import type { HiddenTestResult } from "./hidden-tests.js";
import {
  loadPairs,
  MEMORY_EVAL_DIRS,
  NamespacedMemory,
  renderMemoryAbMarkdown,
  runMemoryAb,
  verifyMemoryManifest,
  type MemoryAbDeps,
  type MemoryAbProgress,
  type Pair,
} from "./memory-ab.js";
import { listHiddenTestFiles, loadEvalMeta, loadTaskSpec } from "./tasks.js";

const PAIR: Pair = {
  id: "p1",
  a: "task-a",
  b: "task-b",
  lesson: "Action endpoints reject unknown body fields.",
  reject_comment: "Unknown body fields must be rejected.",
};

let runs = 0;
function result(status: RunReport["status"], memory?: RunReport["memory"]): RunTaskResult {
  const report = {
    runId: `run-${String(++runs)}`,
    status,
    message: status === "infra_error" ? "provider down" : "ok",
    projectId: "t",
    fixCycles: 0,
    gateFixCycles: 0,
    reviewCycles: 0,
    cost: { totalUsd: 1 },
    worktree: { path: "/wt" },
    spec: { rejections: ["recorded comment"] },
    ...(memory ? { memory } : {}),
  } as unknown as RunReport;
  return { report, reportJsonPath: "", reportMdPath: "" };
}

const hidden = (lessonPassed: boolean): HiddenTestResult => ({
  passed: lessonPassed,
  exitCode: lessonPassed ? 0 : 1,
  timedOut: false,
  total: 2,
  failed: lessonPassed ? 0 : 1,
  durationMs: 1,
  outputTail: "",
  cases: [
    { file: "b.hidden.test.ts", title: "creates it", status: "passed" },
    {
      file: "b.hidden.test.ts",
      title: "[lesson] rejects unknown body fields",
      status: lessonPassed ? "passed" : "failed",
    },
  ],
});

function deps(mem: InMemoryMemory | null, extra: Partial<MemoryAbDeps> = {}) {
  const calls: string[] = [];
  const access: MemoryAccess = {
    memory: mem,
    unavailable: mem ? null : "Ollama is not reachable at http://127.0.0.1:11434",
    limit: 5,
    required: false,
  };
  const d: MemoryAbDeps = {
    pairs: [PAIR],
    repeats: 2,
    namespace: "memeval-1",
    costCapUsd: 100,
    loadTask: (id) => Promise.resolve({ ...FAKE_TASK, id }),
    memory: () => Promise.resolve(access),
    runA: async (task, comment, m) => {
      calls.push(`A ${task.id} required=${String(m.required)} comment=${comment}`);
      await m.memory?.add("t", {
        text: PAIR.lesson,
        source: "spec_rejection_comment",
        runId: "a",
        origin: { kind: "cli" },
      });
      return result("success");
    },
    runB: async (task, m) => {
      if (!m) {
        calls.push(`B ${task.id} off`);
        return result("success");
      }
      const hits = (await m.memory?.search("t", "unknown body fields", 5)) ?? [];
      await expect(
        m.memory?.add("t", {
          text: "a finding of B",
          source: "manual",
          runId: null,
          origin: { kind: "cli" },
        }),
      ).rejects.toThrow(/read-only/);
      calls.push(`B ${task.id} on required=${String(m.required)} hits=${String(hits.length)}`);
      return result("success", {
        status: "used",
        note: "",
        used: hits.map((h) => ({ id: h.record.id, text: h.record.text, source: h.record.source })),
        written: [],
      } as unknown as RunReport["memory"]);
    },
    runHidden: () => Promise.resolve(hidden(true)),
    ...extra,
  };
  return { d, calls };
}

describe("runMemoryAb", () => {
  it("runs A once with the recorded rejection, then B with (read-only) and without memory", async () => {
    const mem = new InMemoryMemory();
    await mem.add("t", {
      text: "Unknown body fields are fine in the real project.",
      source: "manual",
      runId: null,
      origin: { kind: "cli" },
    });
    const { d, calls } = deps(mem, {
      runHidden: (() => {
        let k = 0;
        // memory_on passes the lesson test, memory_off fails it
        return () => Promise.resolve(hidden(k++ < 2));
      })(),
    });
    const s = await runMemoryAb(d);
    expect(s.status).toBe("completed");
    expect(calls).toEqual([
      `A task-a required=true comment=${PAIR.reject_comment}`,
      "B task-b on required=true hits=1", // only the A/B namespace, not the real project's record
      "B task-b on required=true hits=1",
      "B task-b off",
      "B task-b off",
    ]);
    expect(s.lessonsStored).toEqual({ p1: 1 });
    expect(s.metrics.memory_on).toMatchObject({ runs: 2, lessonPassRate: 1, verifiedRate: 1 });
    expect(s.metrics.memory_off).toMatchObject({ runs: 2, lessonPassRate: 0, verifiedRate: 0 });
    expect(s.results.map((r) => r.memoryUsed)).toEqual([1, 1, 0, 0]);
    expect(s.totalCostUsd).toBe(5);
    expect(await mem.list("t")).toHaveLength(1); // the real project's memory is untouched
    expect(renderMemoryAbMarkdown("memeval-1", s)).toContain("| memory_on | 2 | 100.0%");
  });

  it("stops infra_error before any run when memory is unavailable (never a silent memory_off)", async () => {
    const { d, calls } = deps(null);
    const s = await runMemoryAb(d);
    expect(s).toMatchObject({ status: "infra_error", results: [] });
    expect(s.reason).toMatch(/Ollama is not reachable/);
    expect(calls).toEqual([]);
  });

  it("stops infra_error when a run ends infra_error, and at the cost cap", async () => {
    const down = deps(new InMemoryMemory(), { runB: () => Promise.resolve(result("infra_error")) });
    expect(await runMemoryAb(down.d)).toMatchObject({ status: "infra_error", results: [] });
    const capped = deps(new InMemoryMemory(), { costCapUsd: 2 });
    const s = await runMemoryAb(capped.d);
    expect(s.status).toBe("cost_cap_reached");
    expect(s.results).toEqual([]); // A ($1) + one B ($1), then the cap: the pair is not whole
    expect(s.totalCostUsd).toBe(2);
  });

  it("resumes after an interruption: whole pairs kept, the interrupted pair redone in a fresh namespace", async () => {
    const mem = new InMemoryMemory();
    const P2: Pair = { ...PAIR, id: "p2", a: "task-c", b: "task-d" };
    let limit = true;
    let bRuns = 0;
    const saved: MemoryAbProgress[] = [];
    const first = deps(mem, {
      pairs: [PAIR, P2],
      saveProgress: (p) => {
        saved.push(structuredClone(p));
        return Promise.resolve();
      },
    });
    const inner = first.d.runB;
    first.d.runB = (task, m) => {
      // The limit hits on the second pair's second B run.
      if (task.id === "task-d" && ++bRuns === 2 && limit)
        return Promise.resolve(result("infra_error"));
      return inner(task, m);
    };
    const stopped = await runMemoryAb(first.d);
    expect(stopped.status).toBe("infra_error");
    expect(stopped.results.map((r) => r.pair)).toEqual(["p1", "p1", "p1", "p1"]);
    const progress = saved.at(-1);
    expect(progress).toMatchObject({ completedPairs: ["p1"], attempts: { p1: 1, p2: 1 } });

    limit = false;
    const namespaces: string[] = [];
    const second = deps(mem, { pairs: [PAIR, P2], ...(progress ? { progress } : {}) });
    const runA = second.d.runA;
    second.d.runA = async (task, comment, m) => {
      const r = await runA(task, comment, m);
      namespaces.push(...(await mem.list("t~memeval-1-p2-a2")).map((x) => x.text));
      return r;
    };
    const resumed = await runMemoryAb(second.d);
    expect(resumed.status).toBe("completed");
    expect(second.calls.filter((c) => c.startsWith("A "))).toEqual([
      `A task-c required=true comment=${PAIR.reject_comment}`,
    ]); // p1 not redone; p2 from its A
    expect(resumed.attempts).toEqual({ p1: 1, p2: 2 });
    expect(namespaces).toEqual([PAIR.lesson]); // the redo wrote into p2's second namespace
    expect(resumed.results.filter((r) => r.pair === "p2")).toHaveLength(4);
    expect(resumed.totalCostUsd).toBeGreaterThan(stopped.totalCostUsd);
  });

  it("fails loudly when A ran without the recorded rejection (the harness, not memory, is broken)", async () => {
    const { d } = deps(new InMemoryMemory(), {
      runA: () => {
        const r = result("success");
        (r.report as { spec: unknown }).spec = { rejections: [] };
        return Promise.resolve(r);
      },
    });
    await expect(runMemoryAb(d)).rejects.toThrow(/ran without the recorded rejection/);
  });

  it("runs only the chosen condition; --a-only runs A alone and reports its lesson", async () => {
    const onOnly = deps(new InMemoryMemory(), { conditions: ["memory_on"] });
    const s = await runMemoryAb(onOnly.d);
    expect(s.results.map((r) => r.condition)).toEqual(["memory_on", "memory_on"]);
    const aOnly = deps(new InMemoryMemory(), { conditions: [] });
    const a = await runMemoryAb(aOnly.d);
    expect(a).toMatchObject({ status: "completed", results: [], lessonsStored: { p1: 1 } });
    expect(aOnly.calls).toEqual([`A task-a required=true comment=${PAIR.reject_comment}`]);
    const offOnly = deps(new InMemoryMemory(), { conditions: ["memory_off"] });
    const off = await runMemoryAb(offOnly.d);
    expect(offOnly.calls).toEqual(["B task-b off", "B task-b off"]); // no A without memory_on
    expect(off.results).toHaveLength(2);
  });

  it("namespaces never share records", async () => {
    const mem = new InMemoryMemory();
    const a = new NamespacedMemory(mem, "x-p1");
    await a.add("t", {
      text: "rule of p1",
      source: "manual",
      runId: null,
      origin: { kind: "cli" },
    });
    expect(await new NamespacedMemory(mem, "x-p2").list("t")).toEqual([]);
    expect(await a.readOnlyView().list("t")).toHaveLength(1);
    expect(await a.readOnlyView().remove("t", "any")).toBe(false);
  });
});

describe("evals/memory pair set", () => {
  it("matches its manifest (frozen before the first A/B run)", async () => {
    expect(await verifyMemoryManifest()).toEqual([]);
  });

  it("has 4 pairs of existing tasks; every B has hidden [lesson] tests and is implementable", async () => {
    const pairs = await loadPairs();
    expect(pairs).toHaveLength(4);
    for (const p of pairs) {
      await loadTaskSpec(p.a, MEMORY_EVAL_DIRS);
      await loadTaskSpec(p.b, MEMORY_EVAL_DIRS);
      expect((await loadEvalMeta(p.b, MEMORY_EVAL_DIRS)).expected_outcome).toBe("implemented");
      const files = await listHiddenTestFiles(p.b, MEMORY_EVAL_DIRS);
      const text = (await Promise.all(files.map((f) => readFile(f, "utf8")))).join("\n");
      expect(text, p.b).toContain('"[lesson]');
      // the lesson itself is never in the visible task of B
      const visible = await readFile(
        path.join(MEMORY_EVAL_DIRS.tasksDir, p.b, "task.yaml"),
        "utf8",
      );
      expect(visible).not.toContain(p.lesson);
    }
  });
});
