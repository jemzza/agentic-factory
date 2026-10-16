import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  EvalSummarySchema,
  makeEvalId,
  runEval,
  type EvalSummary,
  type EvalTaskInput,
  type RunEvalDeps,
} from "./run-eval.js";

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
  metrics: z.strictObject({
    verifiedRate: StatSchema,
    falseSuccessRate: StatSchema,
    avgFixCycles: StatSchema,
    avgDurationSec: StatSchema,
    totalCostUsd: StatSchema,
  }),
  /** Per task: the outcome in each repeat, in order. */
  tasks: z.record(z.string(), z.array(z.string())),
  repeats: z.array(EvalSummarySchema),
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
  },
): RepeatedSummary {
  const m = (pick: (s: EvalSummary) => number | null) => stat(repeats.map(pick));
  const tasks: Record<string, string[]> = {};
  for (const s of repeats) {
    for (const t of s.tasks) (tasks[t.taskId] ??= []).push(t.correct ? t.outcome : `${t.outcome}✗`);
  }
  return RepeatedSummarySchema.parse({
    schemaVersion: 1,
    evalId,
    repeatsPlanned: info.repeatsPlanned,
    repeatsDone: repeats.length,
    roles: info.roles,
    baselineCommit: info.baselineCommit,
    specApproval: "auto",
    costCapUsd: info.costCapUsd,
    costCapReached: info.costCapReached,
    metrics: {
      verifiedRate: m((s) => s.metrics.verifiedRate),
      falseSuccessRate: m((s) => s.metrics.falseSuccessRate),
      avgFixCycles: m((s) => s.metrics.avgFixCycles),
      avgDurationSec: m((s) => s.metrics.avgDurationSec),
      totalCostUsd: m((s) => s.metrics.totalCostUsd),
    },
    tasks,
    repeats,
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
      `# Eval ${r.evalId} — ${r.repeatsDone}/${r.repeatsPlanned} repeat(s)`,
      [
        `- **Roles:** ${Object.entries(r.roles)
          .map(([k, v]) => `${k} = ${v}`)
          .join("; ")}`,
        `- **Spec approval:** ${r.specApproval} · **Baseline commit:** \`${r.baselineCommit ?? "?"}\``,
        `- **Cost cap:** ${r.costCapUsd === null ? "none" : `$${r.costCapUsd}`}${r.costCapReached ? " — **reached, results are partial**" : ""}`,
      ].join("\n"),
      "## Metrics (mean ± sample stdev across repeats)",
      [
        "| Metric | Value |",
        "|---|---|",
        `| Verified rate | ${fmt(r.metrics.verifiedRate, pct)} |`,
        `| False success rate | ${fmt(r.metrics.falseSuccessRate, pct)} |`,
        `| Average fix cycles | ${fmt(r.metrics.avgFixCycles, num)} |`,
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

/**
 * Runs the task set `repeat` times (sequentially) into runs/eval-<ts>/r<N>/, with ONE cost
 * cap for the whole eval, and writes an aggregated summary with mean and spread.
 */
export async function runEvalRepeated(
  tasks: readonly EvalTaskInput[],
  deps: RunEvalDeps & {
    repeat: number;
    roles: Record<string, string>;
    baselineCommit: string | null;
  },
): Promise<{ summary: RepeatedSummary; summaryMdPath: string }> {
  const evalId = makeEvalId((deps.now ?? (() => new Date()))());
  const root = path.join(deps.runsDir, evalId);
  await mkdir(root, { recursive: true });
  const repeats: EvalSummary[] = [];
  let capReached = false;
  for (let i = 1; i <= deps.repeat; i++) {
    const spent = repeats.reduce((s, r) => s + r.metrics.totalCostUsd, 0);
    const remaining = deps.costCapUsd === undefined ? undefined : deps.costCapUsd - spent;
    if (remaining !== undefined && remaining <= 0) {
      capReached = true;
      deps.log?.(`\nEval cost cap reached before repeat ${i}; stopping.`);
      break;
    }
    deps.log?.(`\n=== repeat ${i}/${deps.repeat} ===`);
    const { summary } = await runEval(tasks, {
      ...deps,
      evalId: `${evalId}/r${i}`,
      evalDir: path.join(root, `r${i}`),
      ...(remaining !== undefined ? { costCapUsd: remaining } : {}),
    });
    repeats.push(summary);
    if (summary.costCap?.reached) {
      capReached = true;
      break;
    }
  }
  const summary = aggregate(evalId, repeats, {
    repeatsPlanned: deps.repeat,
    roles: deps.roles,
    baselineCommit: deps.baselineCommit,
    costCapUsd: deps.costCapUsd ?? null,
    costCapReached: capReached,
  });
  const summaryMdPath = path.join(root, "summary.md");
  await writeFile(path.join(root, "summary.json"), JSON.stringify(summary, null, 2));
  await writeFile(summaryMdPath, renderRepeatedMarkdown(summary));
  return { summary, summaryMdPath };
}
