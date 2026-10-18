import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand, succeeded } from "../process/run-command.js";
import { z } from "zod";
import type { HiddenTestResult } from "./hidden-tests.js";
import {
  aggregate,
  RepeatedSummarySchema,
  renderRepeatedMarkdown,
  type RepeatedSummary,
} from "./repeat.js";
import {
  classify,
  computeMetrics,
  EvalSummarySchema,
  firstPassOf,
  type EvalOutcome,
  type EvalSummary,
  type EvalTaskResult,
  type RescoredFrom,
} from "./run-eval.js";
import { renderEvalSummaryMarkdown } from "./summary-markdown.js";

/**
 * `eval:rescore`: re-judges a finished eval with the CURRENT hidden tests, without calling any
 * agent. For every success claim, the run's stored final diff (`report.json` → `diff`, i.e.
 * `baseCommit..HEAD`) is applied to the baseline tree and the hidden tests run on the result in
 * the sandbox. Every other outcome (needs_clarification, timeout, infra_error, ...) is kept as
 * it is: only a success claim is decided by hidden tests. The source eval is never modified.
 */
export interface RescoreDeps {
  /** Commit the diffs are applied to (the current `factory-baseline`). */
  baselineCommit: string;
  /** Writes the tree of `commit` (no .git) into the empty directory `dest`; false if unknown. */
  materialize: (commit: string, dest: string) => Promise<boolean>;
  /** Runs a task's hidden tests on a prepared tree (on a copy, in the sandbox). */
  runHidden: (treeDir: string, taskId: string) => Promise<HiddenTestResult>;
  /** Factory commit whose hidden tests are used. */
  hiddenTestsCommit: string | null;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface OutcomeChange {
  repeat: number;
  taskId: string;
  from: EvalOutcome;
  to: EvalOutcome;
  failures: string;
}

export interface RescoreResult {
  summary: RepeatedSummary;
  changes: OutcomeChange[];
  outDir: string;
}

/** Reads an eval's summary; a single-pass eval (no repeats) is treated as one repeat. */
export async function loadEvalPasses(
  evalDir: string,
): Promise<{ repeated: RepeatedSummary | null; passes: { dir: string; summary: EvalSummary }[] }> {
  const raw: unknown = JSON.parse(await readFile(path.join(evalDir, "summary.json"), "utf8"));
  const repeated = RepeatedSummarySchema.safeParse(raw);
  if (repeated.success) {
    return {
      repeated: repeated.data,
      passes: repeated.data.repeats.map((summary, i) => ({
        dir: path.join(evalDir, `r${i + 1}`),
        summary,
      })),
    };
  }
  return { repeated: null, passes: [{ dir: evalDir, summary: EvalSummarySchema.parse(raw) }] };
}

/** The fields of a stored `report.json` that a rescore needs (the rest is not read). */
const StoredRunSchema = z.looseObject({
  diff: z.string(),
  target: z.looseObject({ baseCommit: z.string() }).nullable(),
  worktree: z.looseObject({ headCommit: z.string().nullable() }).nullable(),
});

const unavailable = (reason: string): HiddenTestResult => ({
  passed: false,
  exitCode: null,
  timedOut: false,
  total: null,
  failed: null,
  durationMs: 0,
  outputTail: "",
  infraError: reason,
});

/** Builds the rescored tree of one run in `tree`; returns where it came from. */
async function buildTree(
  passDir: string,
  result: EvalTaskResult,
  tree: string,
  deps: RescoreDeps,
): Promise<{ source: "diff" | "commit" } | { source: "unavailable"; reason: string }> {
  if (result.reportPath === null) return { source: "unavailable", reason: "no report" };
  const reportJson = path.join(passDir, path.dirname(result.reportPath), "report.json");
  const report = StoredRunSchema.parse(JSON.parse(await readFile(reportJson, "utf8")));
  if (!(await deps.materialize(deps.baselineCommit, tree))) {
    return { source: "unavailable", reason: `baseline ${deps.baselineCommit} not found` };
  }
  const init = await runCommand("git", ["init", "-q"], { cwd: tree, timeoutMs: 30_000 });
  if (!succeeded(init)) throw new Error(`git init failed in ${tree}: ${init.stderr}`);
  if (report.diff.trim() === "") return { source: "diff" };
  const patch = path.join(path.dirname(tree), "final.diff");
  await writeFile(patch, report.diff);
  const apply = await runCommand("git", ["apply", "--whitespace=nowarn", patch], {
    cwd: tree,
    timeoutMs: 30_000,
  });
  if (succeeded(apply)) return { source: "diff" };
  // The stored diff did not apply (e.g. masked by secret redaction, or another baseline). The
  // run's own head commit is the same tree only if the run started from this very baseline.
  const head = report.worktree?.headCommit;
  if (report.target?.baseCommit === deps.baselineCommit && head) {
    await rm(tree, { recursive: true, force: true });
    await mkdir(tree);
    if (await deps.materialize(head, tree)) return { source: "commit" };
  }
  return {
    source: "unavailable",
    reason: `stored diff does not apply to ${deps.baselineCommit.slice(0, 12)}: ${apply.stderr.trim()}`,
  };
}

async function rescoreTask(
  passDir: string,
  result: EvalTaskResult,
  deps: RescoreDeps,
): Promise<EvalTaskResult> {
  if (result.status !== "success") return result;
  const root = await mkdtemp(path.join(os.tmpdir(), `factory-rescore-${result.taskId}-`));
  try {
    const tree = path.join(root, "tree");
    await mkdir(tree);
    const built = await buildTree(passDir, result, tree, deps);
    let hidden: HiddenTestResult;
    if (built.source === "unavailable") hidden = unavailable(built.reason);
    else {
      try {
        hidden = await deps.runHidden(tree, result.taskId);
      } catch (err) {
        hidden = unavailable(err instanceof Error ? err.message : String(err));
      }
    }
    const { outcome, correct } = classify(result.status, result.expected, hidden);
    return {
      ...result,
      outcome,
      correct,
      firstPass: firstPassOf({ ...result, outcome }),
      hidden: {
        passed: hidden.passed,
        exitCode: hidden.exitCode,
        timedOut: hidden.timedOut,
        total: hidden.total,
        failed: hidden.failed,
        outputTail: hidden.outputTail,
        ...(hidden.infraError !== undefined ? { infraError: hidden.infraError } : {}),
      },
      rescore: { previousOutcome: result.outcome, source: built.source },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function renderChangesMarkdown(changes: readonly OutcomeChange[]): string {
  if (changes.length === 0)
    return "## Outcome changes\n\nNone: every outcome is the same as in the source eval.\n";
  return (
    [
      "## Outcome changes",
      "| Repeat | Task | Before | After | Failing hidden tests |",
      "|---|---|---|---|---|",
      ...changes.map(
        (c) =>
          `| r${c.repeat} | \`${c.taskId}\` | ${c.from} | ${c.to} | ${c.failures.replace(/\|/g, "\\|").replace(/\n/g, "<br>")} |`,
      ),
    ].join("\n") + "\n"
  );
}

/**
 * Rescores every pass of `evalDir` into `<evalDir>/rescore-<ts>/` (summary.json/md per
 * repeat and overall, plus the list of changed outcomes).
 */
export async function rescoreEval(evalDir: string, deps: RescoreDeps): Promise<RescoreResult> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  const sourceEvalId = path.basename(evalDir);
  const at = now();
  const rescoreId = `rescore-${at.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;
  const outDir = path.join(evalDir, rescoreId);
  const rescoredFrom: RescoredFrom = {
    sourceEvalId,
    baselineCommit: deps.baselineCommit,
    hiddenTestsCommit: deps.hiddenTestsCommit,
    rescoredAt: at.toISOString(),
  };
  const { repeated, passes } = await loadEvalPasses(evalDir);
  const changes: OutcomeChange[] = [];
  const rescored: EvalSummary[] = [];
  for (const [i, pass] of passes.entries()) {
    const tasks: EvalTaskResult[] = [];
    for (const t of pass.summary.tasks) {
      log(
        `r${i + 1} ${t.taskId}: ${t.status === "success" ? "rescoring…" : `kept (${t.outcome})`}`,
      );
      const r = await rescoreTask(pass.dir, t, deps);
      if (r.outcome !== t.outcome) {
        changes.push({
          repeat: i + 1,
          taskId: t.taskId,
          from: t.outcome,
          to: r.outcome,
          failures: r.hidden?.infraError ?? r.hidden?.outputTail ?? "",
        });
      }
      if (t.status === "success") {
        log(
          `  → ${r.outcome} (hidden ${r.hidden?.total === null || r.hidden === null ? "?" : r.hidden.total - (r.hidden.failed ?? 0)}/${r.hidden?.total ?? "?"}, from ${r.rescore?.source ?? "?"})`,
        );
      }
      tasks.push(r);
    }
    const summary = EvalSummarySchema.parse({
      ...pass.summary,
      evalId: `${sourceEvalId}/${rescoreId}`,
      metrics: computeMetrics(tasks),
      tasks,
      rescoredFrom,
    });
    rescored.push(summary);
    const dir = repeated ? path.join(outDir, `r${i + 1}`) : outDir;
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "summary.json"), JSON.stringify(summary, null, 2));
    await writeFile(path.join(dir, "summary.md"), renderEvalSummaryMarkdown(summary));
  }
  const summary = aggregate(`${sourceEvalId}/${rescoreId}`, rescored, {
    repeatsPlanned: repeated?.repeatsPlanned ?? 1,
    roles: repeated?.roles ?? passes[0]?.summary.models ?? {},
    baselineCommit: deps.baselineCommit,
    costCapUsd: repeated?.costCapUsd ?? null,
    costCapReached: repeated?.costCapReached ?? false,
    interrupted: repeated?.interrupted ?? false,
    rescoredFrom,
  });
  await mkdir(outDir, { recursive: true });
  if (repeated) {
    await writeFile(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
    await writeFile(path.join(outDir, "summary.md"), renderRepeatedMarkdown(summary));
  }
  await writeFile(path.join(outDir, "changes.md"), renderChangesMarkdown(changes));
  return { summary, changes, outDir };
}
