import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { MemoryAccess } from "../memory/runtime.js";
import {
  ForbiddenMemoryError,
  type MemoryHit,
  type MemoryRecord,
  type NewMemory,
  type ProjectMemory,
} from "../memory/types.js";
import { EVALS_DIR } from "../paths.js";
import type { RunTaskResult } from "../pipeline/run-task.js";
import type { TaskSpec } from "../schemas/task.js";
import type { HiddenTestResult } from "./hidden-tests.js";
import { classify, firstPassOf } from "./run-eval.js";
import type { EvalDirs } from "./tasks.js";

/*
 * Memory A/B (Week 3 Phase 5, design: docs/week3-design.md §11). For each pair "A → B":
 * - memory_on: A runs once; its first spec is rejected with the recorded comment and the
 *   revised spec approved, so the planner's lesson is stored. Then B runs `repeats` times with
 *   memory REQUIRED (unavailable memory is infra_error, never a silent memory_off).
 * - memory_off: B runs `repeats` times without memory.
 * B's hidden tests check the lesson ([lesson] tests) and B's own criteria. Each pair and
 * condition has its own memory namespace, so pairs never share lessons and nothing mixes with
 * a project's real memory. Specs of B are approved automatically in both conditions.
 */

export const MEMORY_EVAL_ROOT = path.join(EVALS_DIR, "memory");
export const MEMORY_EVAL_DIRS: EvalDirs = {
  tasksDir: path.join(MEMORY_EVAL_ROOT, "tasks"),
  hiddenDir: path.join(MEMORY_EVAL_ROOT, "hidden"),
  referenceDir: path.join(MEMORY_EVAL_ROOT, "reference"),
};
const MANIFEST = path.join(MEMORY_EVAL_ROOT, "MANIFEST.sha256");

export const PairSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  a: z.string(),
  b: z.string(),
  lesson: z.string().min(1),
  reject_comment: z.string().min(1),
});
export type Pair = z.infer<typeof PairSchema>;
const PairsFileSchema = z.strictObject({
  version: z.literal(1),
  pairs: z.array(PairSchema).min(4),
});

export async function loadPairs(): Promise<Pair[]> {
  const raw: unknown = parseYaml(await readFile(path.join(MEMORY_EVAL_ROOT, "pairs.yaml"), "utf8"));
  return PairsFileSchema.parse(raw).pairs;
}

async function files(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const p = path.posix.join(rel, e.name);
    if (e.isDirectory()) out.push(...(await files(dir, p)));
    else if (p !== "MANIFEST.sha256") out.push(p);
  }
  return out.sort();
}

/** `sha256  path` for every file of the pair set (frozen before the first A/B run). */
export async function manifestLines(root = MEMORY_EVAL_ROOT): Promise<string[]> {
  const lines: string[] = [];
  for (const f of await files(root)) {
    lines.push(
      `${createHash("sha256")
        .update(await readFile(path.join(root, f)))
        .digest("hex")}  ${f}`,
    );
  }
  return lines;
}

/** Differences between the pair set and its manifest (empty = unchanged since frozen). */
export async function verifyMemoryManifest(): Promise<string[]> {
  const want = (await readFile(MANIFEST, "utf8")).trim().split("\n");
  const have = await manifestLines();
  return [
    ...want
      .filter((l) => !have.includes(l))
      .map((l) => `changed or missing: ${l.split("  ")[1] ?? l}`),
    ...have
      .filter((l) => !want.includes(l))
      .map((l) => `not in manifest: ${l.split("  ")[1] ?? l}`),
  ];
}

export async function writeMemoryManifest(): Promise<void> {
  await writeFile(MANIFEST, `${(await manifestLines()).join("\n")}\n`);
}

/**
 * A ProjectMemory confined to one namespace of a real project's memory. A read-only view
 * refuses writes (the run logs "not stored" and goes on), so B's own review findings never
 * reach the next repeat of B.
 */
export class NamespacedMemory implements ProjectMemory {
  constructor(
    private readonly inner: ProjectMemory,
    private readonly ns: string,
    private readonly readOnly = false,
  ) {}
  readOnlyView(): NamespacedMemory {
    return new NamespacedMemory(this.inner, this.ns, true);
  }
  private key = (projectId: string) => `${projectId}~${this.ns}`;
  search(projectId: string, query: string, limit: number): Promise<MemoryHit[]> {
    return this.inner.search(this.key(projectId), query, limit);
  }
  add(projectId: string, m: NewMemory): Promise<MemoryRecord> {
    if (this.readOnly)
      return Promise.reject(new ForbiddenMemoryError("memory is read-only in this eval run"));
    return this.inner.add(this.key(projectId), m);
  }
  remove(projectId: string, id: string): Promise<boolean> {
    if (this.readOnly) return Promise.resolve(false);
    return this.inner.remove(this.key(projectId), id);
  }
  list(projectId: string): Promise<MemoryRecord[]> {
    return this.inner.list(this.key(projectId));
  }
}

export const CONDITIONS = ["memory_on", "memory_off"] as const;
export type Condition = (typeof CONDITIONS)[number];

export const BResultSchema = z.strictObject({
  pair: z.string(),
  condition: z.enum(CONDITIONS),
  repeat: z.number().int().positive(),
  runId: z.string().nullable(),
  outcome: z.string(),
  verified: z.boolean(),
  firstPass: z.boolean().nullable(),
  reviewCycles: z.number().int().nullable(),
  /** All [lesson] hidden tests passed (null: not measurable, e.g. the run did not succeed). */
  lessonPassed: z.boolean().nullable(),
  /** Records the planner was given (memory_on). */
  memoryUsed: z.number().int(),
  costUsd: z.number(),
});
export type BResult = z.infer<typeof BResultSchema>;

export interface MemoryAbDeps {
  pairs: readonly Pair[];
  repeats: number;
  /**
   * Which B conditions run (default both). `[]` runs only A (a check of the A path: is the
   * recorded rejection applied and a lesson stored?). Without memory_on, A is skipped.
   */
  conditions?: readonly Condition[];
  loadTask: (id: string) => Promise<TaskSpec>;
  /** The memory the A/B runs in (null `memory`: the backend is unavailable). */
  memory: () => Promise<MemoryAccess>;
  /** Unique per A/B run, so that a later A/B never sees this one's lessons. */
  namespace: string;
  /** A with the recorded rejection then approval; returns the finished run. */
  runA: (task: TaskSpec, rejectComment: string, memory: MemoryAccess) => Promise<RunTaskResult>;
  /** B with automatic spec approval; `memory` undefined for memory_off. */
  runB: (task: TaskSpec, memory: MemoryAccess | undefined) => Promise<RunTaskResult>;
  runHidden: (worktreePath: string, taskId: string) => Promise<HiddenTestResult>;
  /** No new run starts once A and B runs together have spent this much. */
  costCapUsd: number;
  /** Progress of an earlier, stopped A/B with the same namespace (resume). */
  progress?: MemoryAbProgress;
  /** Called after every finished pair and before every pair attempt. */
  saveProgress?: (p: MemoryAbProgress) => Promise<void>;
  log?: (m: string) => void;
}

/**
 * What a stopped A/B keeps (runs/<id>/progress.json), so `--resume` does not pay twice. Only
 * whole pairs count: a pair interrupted midway (e.g. by the subscription limit) is redone from
 * its A in a fresh memory namespace (`-a<attempt>`), so a half-finished pair never mixes into
 * the result. `spentUsd` includes the abandoned attempts.
 */
export const MemoryAbProgressSchema = z.strictObject({
  version: z.literal(1),
  completedPairs: z.array(z.string()),
  attempts: z.record(z.string(), z.number().int().positive()),
  results: z.array(BResultSchema),
  lessonsStored: z.record(z.string(), z.number().int()),
  spentUsd: z.number().nonnegative(),
});
export type MemoryAbProgress = z.infer<typeof MemoryAbProgressSchema>;

export const emptyProgress = (): MemoryAbProgress => ({
  version: 1,
  completedPairs: [],
  attempts: {},
  results: [],
  lessonsStored: {},
  spentUsd: 0,
});

export interface MemoryAbSummary {
  status: "completed" | "infra_error" | "cost_cap_reached";
  reason: string | null;
  /** A and B runs together, abandoned pair attempts included. */
  totalCostUsd: number;
  /** Attempts per pair (more than 1: the pair was restarted after an interruption). */
  attempts: Record<string, number>;
  lessonsStored: Record<string, number>;
  results: BResult[];
  metrics: Record<Condition, ConditionMetrics>;
}

export interface ConditionMetrics {
  runs: number;
  verifiedRate: number | null;
  firstPassRate: number | null;
  lessonPassRate: number | null;
  avgReviewCycles: number | null;
  totalCostUsd: number;
}

const rate = (xs: (boolean | null)[]) => {
  const v = xs.filter((x): x is boolean => x !== null);
  return v.length ? v.filter(Boolean).length / v.length : null;
};

export function conditionMetrics(results: readonly BResult[], c: Condition): ConditionMetrics {
  const rs = results.filter((r) => r.condition === c);
  const cycles = rs.map((r) => r.reviewCycles).filter((x): x is number => x !== null);
  return {
    runs: rs.length,
    verifiedRate: rs.length ? rs.filter((r) => r.verified).length / rs.length : null,
    firstPassRate: rate(rs.map((r) => r.firstPass)),
    lessonPassRate: rate(rs.map((r) => r.lessonPassed)),
    avgReviewCycles: cycles.length ? cycles.reduce((a, b) => a + b, 0) / cycles.length : null,
    totalCostUsd: Math.round(rs.reduce((s, r) => s + r.costUsd, 0) * 1e4) / 1e4,
  };
}

/** Did every [lesson] hidden test pass? null when the hidden tests could not judge. */
export function lessonVerdict(h: HiddenTestResult | null): boolean | null {
  if (!h || h.infraError !== undefined) return null;
  const cases = h.cases?.filter((c) => c.title.startsWith(LESSON_PREFIX)) ?? [];
  return cases.length ? cases.every((c) => c.status === "passed") : null;
}

export const LESSON_PREFIX = "[lesson]";

export async function runMemoryAb(deps: MemoryAbDeps): Promise<MemoryAbSummary> {
  const log = deps.log ?? (() => undefined);
  const conditions: readonly Condition[] = deps.conditions ?? CONDITIONS;
  const progress = structuredClone(deps.progress ?? emptyProgress());
  const results = progress.results;
  const lessonsStored = progress.lessonsStored;
  let spent = progress.spentUsd;
  const save = async () => {
    progress.spentUsd = Math.round(spent * 1e4) / 1e4;
    await deps.saveProgress?.(progress);
  };
  const done = (status: MemoryAbSummary["status"], reason: string | null): MemoryAbSummary => ({
    status,
    reason,
    totalCostUsd: Math.round(spent * 1e4) / 1e4,
    attempts: progress.attempts,
    lessonsStored,
    results,
    metrics: {
      memory_on: conditionMetrics(results, "memory_on"),
      memory_off: conditionMetrics(results, "memory_off"),
    },
  });

  const overCap = () => spent >= deps.costCapUsd;

  let pairResults: BResult[] = [];
  const judge = async (
    pair: Pair,
    condition: Condition,
    repeat: number,
    run: RunTaskResult,
    memoryUsed: number,
  ) => {
    const r = run.report;
    let hidden: HiddenTestResult | null = null;
    if (r.status === "success" && r.worktree)
      hidden = await deps.runHidden(r.worktree.path, pair.b);
    const { outcome, correct } = classify(r.status, "implemented", hidden);
    const counters = {
      fixCycles: r.fixCycles,
      gateFixCycles: r.gateFixCycles ?? null,
      reviewCycles: r.reviewCycles ?? null,
    };
    pairResults.push(
      BResultSchema.parse({
        pair: pair.id,
        condition,
        repeat,
        runId: r.runId,
        outcome,
        verified: correct,
        firstPass: firstPassOf({ expected: "implemented", outcome, ...counters }),
        reviewCycles: r.reviewCycles ?? null,
        lessonPassed: lessonVerdict(hidden),
        memoryUsed: r.memory?.used.length ?? 0,
        costUsd: r.cost.totalUsd,
      }),
    );
    log(
      `  ${pair.id} ${condition} r${repeat}: ${outcome}${memoryUsed ? `, ${memoryUsed} record(s) given` : ""}, $${r.cost.totalUsd.toFixed(3)}`,
    );
    return outcome;
  };

  for (const pair of deps.pairs) {
    if (progress.completedPairs.includes(pair.id)) {
      log(`\n=== ${pair.id}: already done (resume) ===`);
      continue;
    }
    const a = await deps.loadTask(pair.a);
    const b = await deps.loadTask(pair.b);
    const attempt = (progress.attempts[pair.id] ?? 0) + 1;
    progress.attempts[pair.id] = attempt;
    await save();
    pairResults = [];

    // memory_on: one A, then B with the lesson. A fresh namespace per attempt.
    if (!conditions.includes("memory_on") && conditions.length > 0) {
      // memory_off alone needs no A and no memory.
      for (let i = 1; i <= deps.repeats; i++) {
        if (overCap()) {
          await save();
          return done("cost_cap_reached", `cost cap $${String(deps.costCapUsd)} reached`);
        }
        const rb = await deps.runB(b, undefined);
        spent += rb.report.cost.totalUsd;
        if (rb.report.status === "infra_error") {
          await save();
          return done("infra_error", rb.report.message);
        }
        await judge(pair, "memory_off", i, rb, 0);
      }
      results.push(...pairResults);
      progress.completedPairs.push(pair.id);
      await save();
      continue;
    }
    const access = await deps.memory();
    if (!access.memory)
      return done("infra_error", `memory unavailable: ${access.unavailable ?? ""}`);
    const ns = new NamespacedMemory(
      access.memory,
      `${deps.namespace}-${pair.id}-a${String(attempt)}`,
    );
    log(`\n=== ${pair.id} (attempt ${String(attempt)}): A ${pair.a} (recorded rejection) ===`);
    const stop = async (status: MemoryAbSummary["status"], reason: string) => {
      await save();
      return done(status, reason);
    };
    if (overCap()) return stop("cost_cap_reached", `cost cap $${String(deps.costCapUsd)} reached`);
    const ra = await deps.runA(a, pair.reject_comment, { ...access, memory: ns, required: true });
    spent += ra.report.cost.totalUsd;
    if (ra.report.status === "infra_error") return stop("infra_error", ra.report.message);
    // The pair measures nothing unless A's spec was really rejected by the recorded comment.
    if (
      ra.report.status !== "needs_clarification" &&
      (ra.report.spec?.rejections.length ?? 0) === 0
    ) {
      await save();
      throw new Error(
        `A ${pair.a} of ${pair.id} ran without the recorded rejection: the A/B harness is broken`,
      );
    }
    const lessons = (await ns.list(ra.report.projectId ?? "")).filter(
      (m) => m.source === "spec_rejection_comment",
    ).length;
    const forB: MemoryAccess = { ...access, memory: ns.readOnlyView(), required: true };
    for (const [condition, memory] of (
      [
        ["memory_on", forB],
        ["memory_off", undefined],
      ] as const
    ).filter(([c]) => conditions.includes(c))) {
      for (let i = 1; i <= deps.repeats; i++) {
        if (overCap())
          return stop("cost_cap_reached", `cost cap $${String(deps.costCapUsd)} reached`);
        const rb = await deps.runB(b, memory);
        spent += rb.report.cost.totalUsd;
        if (rb.report.status === "infra_error") return stop("infra_error", rb.report.message);
        await judge(pair, condition, i, rb, rb.report.memory?.used.length ?? 0);
      }
    }
    // The pair is whole: only now does it enter the result.
    results.push(...pairResults);
    lessonsStored[pair.id] = lessons;
    progress.completedPairs.push(pair.id);
    await save();
  }
  return done("completed", null);
}

export function renderMemoryAbMarkdown(id: string, s: MemoryAbSummary): string {
  const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
  const num = (x: number | null) => (x === null ? "n/a" : x.toFixed(2));
  const row = (c: Condition) => {
    const m = s.metrics[c];
    return `| ${c} | ${m.runs} | ${pct(m.verifiedRate)} | ${pct(m.firstPassRate)} | ${pct(m.lessonPassRate)} | ${num(m.avgReviewCycles)} | $${m.totalCostUsd.toFixed(2)} |`;
  };
  return (
    [
      `# Memory A/B ${id}${s.status === "completed" ? "" : ` — STOPPED: ${s.status}`}`,
      `Total cost (A and B): $${s.totalCostUsd.toFixed(2)}`,
      ...(s.reason ? [`> ${s.reason}`] : []),
      "| Condition | B runs | Verified | First pass | Lesson tests passed | Avg review cycles | Cost |",
      "|---|---|---|---|---|---|---|",
      row("memory_on"),
      row("memory_off"),
      `Pair attempts: ${Object.entries(s.attempts)
        .map(([p, n]) => `${p} ×${String(n)}`)
        .join(", ")} (more than 1: restarted after an interruption; only whole pairs count)`,
      "## Lessons stored by A",
      Object.entries(s.lessonsStored)
        .map(([p, n]) => `- ${p}: ${n}`)
        .join("\n") || "_none_",
      "## Runs",
      "| Pair | Condition | Repeat | Outcome | Lesson | Memory given | Cost |",
      "|---|---|---|---|---|---|---|",
      ...s.results.map(
        (r) =>
          `| ${r.pair} | ${r.condition} | ${r.repeat} | ${r.outcome} | ${r.lessonPassed === null ? "n/a" : r.lessonPassed ? "pass" : "fail"} | ${r.memoryUsed} | $${r.costUsd.toFixed(3)} |`,
      ),
    ].join("\n\n") + "\n"
  );
}

export async function writeMemoryAb(dir: string, id: string, s: MemoryAbSummary): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "summary.json"), JSON.stringify({ id, ...s }, null, 2));
  const md = path.join(dir, "summary.md");
  await writeFile(md, renderMemoryAbMarkdown(id, s));
  return md;
}
