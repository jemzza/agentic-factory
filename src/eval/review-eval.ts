import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { buildSystemPrompt, promptVars } from "../agents/prompts.js";
import type { ProjectConfig } from "../schemas/project.js";
import {
  isApproved,
  REVIEWER_OUTPUT_SCHEMA,
  reviewerPrompt,
  reviewWithRetry,
} from "../agents/reviewer.js";
import { git } from "../git/git.js";
import { READ_ONLY_TOOLS } from "../runtimes/tool-policy.js";
import type { AgentRunResult, AgentRuntime } from "../runtimes/types.js";
import type { ReviewVerdict } from "../schemas/agents.js";
import type { TaskSpec } from "../schemas/task.js";
import type { ReviewCase } from "./review-cases.js";
import { applyPatch, prepareTargetCopy } from "./target-copy.js";

/** Per-case score, by the rules fixed in evals/review/README.md before the first run. */
export const CaseScoreSchema = z.strictObject({
  caseId: z.string(),
  kind: z.enum(["clean", "defect"]),
  /** Reviewer did not approve (isApproved = false). */
  flagged: z.boolean(),
  /** Defect cases: flagged AND a blocker/major issue on one of the defect's files. */
  found: z.boolean(),
  /** The reviewer's answer stayed invalid after the retry (or the agent failed). */
  error: z.string().nullable(),
  verdict: z.enum(["approve", "request_changes"]).nullable(),
  issues: z.number().int(),
  attempts: z.number().int(),
  costUsd: z.number().nullable(),
  durationMs: z.number().int(),
});
export type CaseScore = z.infer<typeof CaseScoreSchema>;

/**
 * Compares an issue's `file` with a defect file. Reviewers may append a line or a range
 * ("src/app.ts:42-48"); that suffix is not part of the file (bug found in the first two-reviewer
 * run, 2026-10-16; the scoring rule itself is unchanged).
 */
const fileMatches = (issueFile: string, defectFile: string) => {
  const a = issueFile
    .trim()
    .replace(/:\d+(?:-\d+)?$/, "")
    .replace(/^\.?\//, "");
  return (
    a !== "" && (a === defectFile || a.endsWith(`/${defectFile}`) || defectFile.endsWith(`/${a}`))
  );
};

export function scoreCase(c: ReviewCase, verdict: ReviewVerdict | null, error: string | null) {
  if (!verdict) return { flagged: false, found: false, error: error ?? "no verdict" };
  const flagged = !isApproved(verdict);
  const found =
    c.kind === "defect" &&
    flagged &&
    verdict.issues.some(
      (i) => i.severity !== "minor" && (c.defect?.files ?? []).some((f) => fileMatches(i.file, f)),
    );
  return { flagged, found, error: null };
}

export const ReviewerMetricsSchema = z.strictObject({
  reviewer: z.string(),
  defects: z.number().int(),
  clean: z.number().int(),
  found: z.number().int(),
  flaggedDefects: z.number().int(),
  falsePositives: z.number().int(),
  /** found / defects (strict rule). */
  recall: z.number(),
  /** flagged / defects (lenient rule). */
  recallLenient: z.number(),
  /** false positives / clean cases. */
  falsePositiveRate: z.number(),
  errors: z.number().int(),
  retries: z.number().int(),
  costUsd: z.number(),
  unknownCostCases: z.number().int(),
  avgDurationSec: z.number(),
});
export type ReviewerMetrics = z.infer<typeof ReviewerMetricsSchema>;

const ratio = (a: number, b: number) => (b === 0 ? 0 : Math.round((a / b) * 1000) / 1000);

export function reviewerMetrics(reviewer: string, scores: readonly CaseScore[]): ReviewerMetrics {
  const defects = scores.filter((s) => s.kind === "defect");
  const clean = scores.filter((s) => s.kind === "clean");
  const found = defects.filter((s) => s.found).length;
  const flaggedDefects = defects.filter((s) => s.flagged).length;
  const falsePositives = clean.filter((s) => s.flagged).length;
  return {
    reviewer,
    defects: defects.length,
    clean: clean.length,
    found,
    flaggedDefects,
    falsePositives,
    recall: ratio(found, defects.length),
    recallLenient: ratio(flaggedDefects, defects.length),
    falsePositiveRate: ratio(falsePositives, clean.length),
    errors: scores.filter((s) => s.error !== null).length,
    retries: scores.filter((s) => s.attempts > 1).length,
    costUsd: Math.round(scores.reduce((sum, s) => sum + (s.costUsd ?? 0), 0) * 1e4) / 1e4,
    unknownCostCases: scores.filter((s) => s.costUsd === null).length,
    avgDurationSec: scores.length
      ? Math.round(scores.reduce((sum, s) => sum + s.durationMs, 0) / scores.length / 100) / 10
      : 0,
  };
}

export interface ReviewerUnderTest {
  /** Label, e.g. "claude-code:opus" or "opencode:openai/<id>". */
  label: string;
  runtime: AgentRuntime;
  model: string;
}

/**
 * Runs every reviewer on every case: a fresh copy of the baseline with the case's diff
 * committed on top, the case's task definition, the same prompt and the same single retry as
 * the graph's review node. Returns one score per (reviewer, case).
 */
export async function runReviewEval(opts: {
  cases: readonly ReviewCase[];
  reviewers: readonly ReviewerUnderTest[];
  loadTask: (id: string) => Promise<TaskSpec>;
  baselineSource: string;
  /** The stand project's config: conventions file name and prompt facts. */
  projectConfig: ProjectConfig;
  outDir: string;
  maxDiffChars: number;
  timeoutMs: number;
  log?: (m: string) => void;
}): Promise<Record<string, CaseScore[]>> {
  const log = opts.log ?? (() => undefined);
  const results: Record<string, CaseScore[]> = {};
  for (const reviewer of opts.reviewers) {
    const scores: CaseScore[] = [];
    for (const c of opts.cases) {
      const work = await mkdtemp(path.join(os.tmpdir(), `factory-review-${c.id}-`));
      const started = Date.now();
      try {
        const repo = path.join(work, "repo");
        await prepareTargetCopy({ source: opts.baselineSource, dest: repo });
        await git(repo, ["add", "-A"]);
        await git(repo, ["commit", "-q", "--no-verify", "-m", "baseline"]);
        const base = (await git(repo, ["rev-parse", "HEAD"])).trim();
        await applyPatch(repo, c.patchPath);
        await git(repo, ["add", "-A"]);
        await git(repo, ["commit", "-q", "--no-verify", "-m", c.id]);
        const diff = await git(repo, ["diff", "--no-color", base, "HEAD"]);
        const task = await opts.loadTask(c.task);
        const conventions = await readFile(
          path.join(repo, opts.projectConfig.conventions_file),
          "utf8",
        ).catch(() => "");
        const systemPrompt = await buildSystemPrompt(
          "reviewer",
          conventions,
          promptVars(opts.projectConfig),
        );
        const logDir = path.join(
          opts.outDir,
          reviewer.label.replace(/[^a-zA-Z0-9._-]/g, "_"),
          c.id,
        );
        await mkdir(logDir, { recursive: true });
        let costUsd: number | null = 0;
        let n = 0;
        const { outcome, attempts } = await reviewWithRetry(
          async (prompt): Promise<AgentRunResult> => {
            const res = await reviewer.runtime.run({
              role: "reviewer",
              prompt,
              cwd: repo,
              allowedTools: [...READ_ONLY_TOOLS],
              timeoutMs: opts.timeoutMs,
              systemPrompt,
              model: reviewer.model,
              outputSchema: REVIEWER_OUTPUT_SCHEMA,
              logPath: path.join(logDir, `attempt-${++n}.jsonl`),
            });
            costUsd = res.costUsd === undefined || costUsd === null ? null : costUsd + res.costUsd;
            return res;
          },
          reviewerPrompt(task, diff, opts.maxDiffChars),
          task,
        );
        const verdict = outcome.ok ? outcome.value : null;
        const s = scoreCase(
          c,
          verdict,
          outcome.ok ? null : `${outcome.error.kind}: ${outcome.error.message}`,
        );
        await writeFile(
          path.join(logDir, "verdict.json"),
          JSON.stringify({ outcome, score: s }, null, 2),
        );
        scores.push(
          CaseScoreSchema.parse({
            caseId: c.id,
            kind: c.kind,
            ...s,
            verdict: verdict?.verdict ?? null,
            issues: verdict?.issues.length ?? 0,
            attempts,
            costUsd,
            durationMs: Date.now() - started,
          }),
        );
        log(
          `  ${reviewer.label} ${c.id}: ${verdict?.verdict ?? "ERROR"}${c.kind === "defect" ? (s.found ? " → found" : s.flagged ? " → flagged (wrong file)" : " → MISSED") : s.flagged ? " → FALSE POSITIVE" : " → ok"}`,
        );
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    }
    results[reviewer.label] = scores;
  }
  return results;
}

export function renderReviewEvalMarkdown(
  evalId: string,
  results: Record<string, CaseScore[]>,
): string {
  const metrics = Object.entries(results).map(([r, s]) => reviewerMetrics(r, s));
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  const lines = [
    `# Reviewer eval ${evalId}`,
    "Scoring rules: evals/review/README.md (fixed before the first run). Recall is strict (not approved AND a blocker/major issue on the defect's file); lenient = not approved.",
    "## Metrics",
    [
      "| Reviewer | Recall (strict) | Recall (lenient) | False positive rate | Invalid answers | Retries | Cost | Avg time |",
      "|---|---|---|---|---|---|---|---|",
      ...metrics.map(
        (m) =>
          `| ${m.reviewer} | **${pct(m.recall)}** (${m.found}/${m.defects}) | ${pct(m.recallLenient)} (${m.flaggedDefects}/${m.defects}) | **${pct(m.falsePositiveRate)}** (${m.falsePositives}/${m.clean}) | ${m.errors} | ${m.retries} | $${m.costUsd.toFixed(3)}${m.unknownCostCases ? ` (+${m.unknownCostCases} unknown)` : ""} | ${m.avgDurationSec}s |`,
      ),
    ].join("\n"),
    "## Per case",
    [
      `| Case | ${Object.keys(results).join(" | ")} |`,
      `|---|${Object.keys(results)
        .map(() => "---")
        .join("|")}|`,
      ...(Object.values(results)[0] ?? []).map((first, i) => {
        const cells = Object.values(results).map((scores) => {
          const s = scores[i];
          if (!s) return "—";
          if (s.error) return `error`;
          return s.kind === "defect"
            ? s.found
              ? "✅ found"
              : s.flagged
                ? "⚠ flagged, wrong file"
                : "❌ missed"
            : s.flagged
              ? "❌ false positive"
              : "✅ approved";
        });
        return `| \`${first.caseId}\` | ${cells.join(" | ")} |`;
      }),
    ].join("\n"),
  ];
  return lines.join("\n\n") + "\n";
}
