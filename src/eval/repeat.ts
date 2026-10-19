import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  EvalSummarySchema,
  RescoredFromSchema,
  makeEvalId,
  runEval,
  type EvalSummary,
  type EvalTaskInput,
  type RescoredFrom,
  type RunEvalDeps,
} from "./run-eval.js";
import { rescoredBanner } from "./summary-markdown.js";

export const StatSchema = z.strictObject({
  n: z.number().int(),
  mean: z.number().nullable(),
  /** Sample standard deviation (null for fewer than two values). */
  stdev: z.number().nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
});
export type Stat = z.infer<typeof StatSchema>;

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

export function stat(values: readonly (number | null)[]): Stat {
  const v = values.filter((x): x is number => x !== null);
  if (v.length === 0) return { n: 0, mean: null, stdev: null, min: null, max: null };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const stdev =
    v.length > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1)) : null;
  return {
    n: v.length,
    mean: r4(mean),
    stdev: stdev === null ? null : r4(stdev),
    min: r4(Math.min(...v)),
    max: r4(Math.max(...v)),
  };
}

const NO_STAT: Stat = { n: 0, mean: null, stdev: null, min: null, max: null };

export const RepeatedSummarySchema = z.strictObject({
  schemaVersion: z.literal(1),
  evalId: z.string(),
  repeatsPlanned: z.number().int().positive(),
  repeatsDone: z.number().int().nonnegative(),
  roles: z.record(z.string(), z.string()),
  baselineCommit: z.string().nullable(),
  specApproval: z.literal("auto"),
  costCapUsd: z.number().nullable(),
  costCapReached: z.boolean(),
  /** A pass stopped because the provider was unavailable; `--resume` continues it. */
  interrupted: z.boolean().default(false),
  metrics: z.strictObject({
    /** Added with the cycle-budget split; absent in summaries written before it. */
    firstPassRate: StatSchema.default(NO_STAT),
    verifiedRate: StatSchema,
    falseSuccessRate: StatSchema,
    avgFixCycles: StatSchema,
    avgGateFixCycles: StatSchema.default(NO_STAT),
    avgReviewCycles: StatSchema.default(NO_STAT),
    reviewLimitStopRate: StatSchema.default(NO_STAT),
    avgDurationSec: StatSchema,
    totalCostUsd: StatSchema,
  }),
  /** Per task: the outcome in each repeat, in order. */
  tasks: z.record(z.string(), z.array(z.string())),
  repeats: z.array(EvalSummarySchema),
  /** Set when produced by `eval:rescore` from another eval (see RescoredFromSchema). */
  rescoredFrom: RescoredFromSchema.nullable().default(null),
});
export type RepeatedSummary = z.infer<typeof RepeatedSummarySchema>;

export function aggregate(
  evalId: string,
  repeats: readonly EvalSummary[],
  info: {
    repeatsPlanned: number;
    roles: Record<string, string>;
    baselineCommit: string | null;
    costCapUsd: number | null;
    costCapReached: boolean;
    interrupted?: boolean;
    rescoredFrom?: RescoredFrom | null;
  },
): RepeatedSummary {
  // Statistics only over complete passes: an interrupted pass has not decided every task.
  const complete = repeats.filter((r) => r.interrupted === null);
  const m = (pick: (s: EvalSummary) => number | null) => stat(complete.map(pick));
  const tasks: Record<string, string[]> = {};
  for (const s of repeats) {
    for (const t of s.tasks) (tasks[t.taskId] ??= []).push(t.correct ? t.outcome : `${t.outcome}✗`);
  }
  return RepeatedSummarySchema.parse({
    schemaVersion: 1,
    evalId,
    repeatsPlanned: info.repeatsPlanned,
    repeatsDone: complete.length,
    roles: info.roles,
    baselineCommit: info.baselineCommit,
    specApproval: "auto",
    costCapUsd: info.costCapUsd,
    costCapReached: info.costCapReached,
    interrupted: info.interrupted ?? false,
    metrics: {
      firstPassRate: m((s) => s.metrics.firstPassRate),
      verifiedRate: m((s) => s.metrics.verifiedRate),
      falseSuccessRate: m((s) => s.metrics.falseSuccessRate),
      avgFixCycles: m((s) => s.metrics.avgFixCycles),
      avgGateFixCycles: m((s) => s.metrics.avgGateFixCycles),
      avgReviewCycles: m((s) => s.metrics.avgReviewCycles),
      reviewLimitStopRate: m((s) => s.metrics.reviewLimitStopRate),
      avgDurationSec: m((s) => s.metrics.avgDurationSec),
      totalCostUsd: m((s) => s.metrics.totalCostUsd + s.replacedCostUsd),
    },
    tasks,
    repeats,
    rescoredFrom: info.rescoredFrom ?? null,
  });
}

function fmt(s: Stat, unit: (x: number) => string): string {
  if (s.mean === null) return "n/a";
  const spread = s.stdev === null ? "" : ` ± ${unit(s.stdev)}`;
  return `**${unit(s.mean)}**${spread} (min ${unit(s.min ?? 0)}, max ${unit(s.max ?? 0)}, n=${s.n})`;
}

export function renderRepeatedMarkdown(r: RepeatedSummary): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const num = (x: number) => x.toFixed(2);
  const sec = (x: number) => `${x.toFixed(1)}s`;
  const usd = (x: number) => `$${x.toFixed(2)}`;
  return (
    [
      `# Eval ${r.evalId} — ${r.repeatsDone}/${r.repeatsPlanned} repeat(s)${r.rescoredFrom ? " — rescored" : ""}`,
      ...(r.rescoredFrom ? [rescoredBanner(r.rescoredFrom)] : []),
      [
        `- **Roles:** ${Object.entries(r.roles)
          .map(([k, v]) => `${k} = ${v}`)
          .join("; ")}`,
        `- **Spec approval:** ${r.specApproval} · **Baseline commit:** \`${r.baselineCommit ?? "?"}\``,
        `- **Cost cap:** ${r.costCapUsd === null ? "none" : `$${r.costCapUsd}`}${r.costCapReached ? " — **reached, results are partial**" : ""}`,
        `- **Factory commit per repeat:** ${r.repeats.map((p, i) => `r${i + 1} ${p.factoryCommit ? `\`${p.factoryCommit}\`` : "not recorded"}`).join(", ")}`,
        ...(r.interrupted
          ? [
              "- **Interrupted: the model provider was unavailable.** Resume with `npm run eval -- --resume " +
                r.evalId +
                "`; statistics cover complete repeats only.",
            ]
          : []),
      ].join("\n"),
      "## Metrics (mean ± sample stdev across repeats)",
      [
        "| Metric | Value |",
        "|---|---|",
        `| First-pass rate (verified, no rework / implementable tasks) | ${fmt(r.metrics.firstPassRate, pct)} |`,
        `| Verified rate | ${fmt(r.metrics.verifiedRate, pct)} |`,
        `| False success rate | ${fmt(r.metrics.falseSuccessRate, pct)} |`,
        `| Average gate fix cycles | ${fmt(r.metrics.avgGateFixCycles, num)} |`,
        `| Average review cycles | ${fmt(r.metrics.avgReviewCycles, num)} |`,
        `| Average fix cycles, total | ${fmt(r.metrics.avgFixCycles, num)} |`,
        `| Stopped by the review limit (review_rejected / reviewed) | ${fmt(r.metrics.reviewLimitStopRate, pct)} |`,
        `| Excluded: provider unavailable (infra_error), all repeats | ${r.repeats.reduce((n, p) => n + p.metrics.excludedInfra + p.replacedInfraTasks.length, 0)} task attempt(s) |`,
        `| Average time per task | ${fmt(r.metrics.avgDurationSec, sec)} |`,
        `| Cost per repeat | ${fmt(r.metrics.totalCostUsd, usd)} |`,
      ].join("\n"),
      "## Outcomes per task (✗ = not the correct outcome)",
      [
        `| Task | ${r.repeats.map((_, i) => `r${i + 1}`).join(" | ")} |`,
        `|---|${r.repeats.map(() => "---").join("|")}|`,
        ...Object.entries(r.tasks).map(([t, o]) => `| \`${t}\` | ${o.join(" | ")} |`),
      ].join("\n"),
      "Per-repeat details: `r<N>/summary.md`.",
    ].join("\n\n") + "\n"
  );
}

export interface RepeatOptions {
  repeat: number;
  roles: Record<string, string>;
  baselineCommit: string | null;
  /** Continue this eval: finish interrupted passes, then add repeats up to `repeat`. */
  resumeEvalId?: string;
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * What an eval being resumed was measured with. Anything that changes the measurement makes
 * new passes incomparable with the old ones, so a mismatch refuses the resume (start a new
 * eval instead).
 */
export function resumeMismatch(
  stored: { roles: Record<string, string>; baselineCommit: string | null; taskIds: string[] },
  current: { roles: Record<string, string>; baselineCommit: string | null; taskIds: string[] },
): string | null {
  const roles = (r: Record<string, string>) =>
    Object.entries(r)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
  if (roles(stored.roles) !== roles(current.roles))
    return `roles differ: eval has ${roles(stored.roles)}, config has ${roles(current.roles)}`;
  if (stored.baselineCommit !== current.baselineCommit)
    return `baseline commit differs: eval ${stored.baselineCommit ?? "?"}, now ${current.baselineCommit ?? "?"}`;
  // A set, not a sequence: a parallel pass records its tasks in the order they finished.
  const set = (ids: readonly string[]) => [...ids].sort().join(",");
  if (set(stored.taskIds) !== set(current.taskIds))
    return `task set differs: eval ran ${stored.taskIds.join(", ")}`;
  return null;
}

/**
 * Runs the task set `repeat` times (sequentially) into runs/eval-<ts>/r<N>/, with ONE cost
 * cap for the whole eval, and writes an aggregated summary with mean and spread after every
 * pass. A pass interrupted by the provider (infra_error) stops the eval; `resumeEvalId`
 * continues it: decided tasks are kept, the rest run, then missing repeats are added.
 */
export async function runEvalRepeated(
  tasks: readonly EvalTaskInput[],
  deps: RunEvalDeps & RepeatOptions,
): Promise<{ summary: RepeatedSummary; summaryMdPath: string }> {
  const evalId = deps.resumeEvalId ?? makeEvalId((deps.now ?? (() => new Date()))());
  const root = path.join(deps.runsDir, evalId);
  const taskIds = tasks.map((t) => t.task.id);

  const previous: EvalSummary[] = [];
  let repeatsPlanned = deps.repeat;
  if (deps.resumeEvalId) {
    const stored = await readJson(path.join(root, "summary.json"));
    if (stored === undefined) throw new Error(`eval ${evalId}: no summary.json under ${root}`);
    const s = RepeatedSummarySchema.parse(stored);
    for (let i = 1; ; i++) {
      const pass = await readJson(path.join(root, `r${i}`, "summary.json"));
      if (pass === undefined) break;
      previous.push(EvalSummarySchema.parse(pass));
    }
    const firstTasks = previous[0]?.tasks.map((t) => t.taskId) ?? [];
    const pending = previous[0]?.interrupted?.pendingTasks ?? [];
    const why = resumeMismatch(
      {
        roles: s.roles,
        baselineCommit: s.baselineCommit,
        taskIds: [...firstTasks, ...pending.filter((t) => !firstTasks.includes(t))],
      },
      { roles: deps.roles, baselineCommit: deps.baselineCommit, taskIds },
    );
    if (why) throw new Error(`cannot resume ${evalId}: ${why}`);
    repeatsPlanned = Math.max(deps.repeat, s.repeatsPlanned, previous.length);
  }
  await mkdir(root, { recursive: true });

  const repeats: EvalSummary[] = [];
  let capReached = false;
  let interrupted = false;
  const write = async () => {
    const summary = aggregate(evalId, repeats, {
      repeatsPlanned,
      roles: deps.roles,
      baselineCommit: deps.baselineCommit,
      costCapUsd: deps.costCapUsd ?? null,
      costCapReached: capReached,
      interrupted,
    });
    const summaryMdPath = path.join(root, "summary.md");
    await writeFile(path.join(root, "summary.json"), JSON.stringify(summary, null, 2));
    await writeFile(summaryMdPath, renderRepeatedMarkdown(summary));
    return { summary, summaryMdPath };
  };

  for (let i = 1; i <= repeatsPlanned; i++) {
    const prev = previous[i - 1];
    const covered = new Set(prev?.tasks.map((t) => t.taskId));
    if (prev && prev.interrupted === null && taskIds.every((t) => covered.has(t))) {
      repeats.push(prev);
      deps.log?.(`\n=== repeat ${i}/${repeatsPlanned}: complete, kept ===`);
      continue;
    }
    const spent = repeats.reduce(
      (s, r) =>
        s +
        r.metrics.totalCostUsd +
        r.replacedCostUsd +
        r.pausedRuns.reduce((p, x) => p + x.spentUsd, 0),
      0,
    );
    const remaining = deps.costCapUsd === undefined ? undefined : deps.costCapUsd - spent;
    if (remaining !== undefined && remaining <= 0) {
      capReached = true;
      deps.log?.(`\nEval cost cap reached before repeat ${i}; stopping.`);
      break;
    }
    deps.log?.(`\n=== repeat ${i}/${repeatsPlanned}${prev ? " (resumed)" : ""} ===`);
    const { summary } = await runEval(tasks, {
      ...deps,
      evalId: `${evalId}/r${i}`,
      evalDir: path.join(root, `r${i}`),
      ...(remaining !== undefined ? { costCapUsd: remaining } : {}),
      ...(prev ? { previous: prev } : {}),
    });
    repeats.push(summary);
    if (summary.interrupted) {
      interrupted = true;
      break;
    }
    if (summary.costCap?.reached) {
      capReached = true;
      break;
    }
    await write();
  }
  return write();
}
