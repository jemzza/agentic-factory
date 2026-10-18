import { readFile } from "node:fs/promises";
import path from "node:path";
import { RepeatedSummarySchema, type RepeatedSummary } from "../eval/repeat.js";
import { RunReportSchema, type RunReport } from "../schemas/report.js";
import type { EvalRow, RunRow, Store } from "../store/store.js";

/**
 * What the dashboard reads: the database (source of truth) and the report files it points to.
 * Files are read only inside `runsRoot`; a path pointing elsewhere is ignored. Nothing here
 * writes: the server opens the database with `query_only`.
 */
export interface DashboardSource {
  store: Store;
  /** The factory's `runs/` directory. */
  runsRoot: string;
  /** projectId → `owner/name` for issue and PR links (projects with a `github` entry). */
  githubRepos: Record<string, string>;
}

/** A file the dashboard could not use, and why (shown on the page instead of the content). */
export interface Unreadable {
  problem: string;
}

const inside = (root: string, file: string) => {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

async function readInside(root: string, file: string): Promise<string | Unreadable> {
  if (!inside(root, file)) return { problem: `outside the runs directory: ${file}` };
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    return { problem: err instanceof Error ? err.message : String(err) };
  }
}

const isText = (x: string | Unreadable): x is string => typeof x === "string";

/** Where a run writes its files: next to its report, else the layout of `runs/`. */
export function runDir(src: DashboardSource, run: RunRow): string {
  if (run.report_path) return path.dirname(run.report_path);
  if (run.eval_id && run.eval_repeat !== null)
    return path.join(src.runsRoot, run.eval_id, `r${String(run.eval_repeat)}`, run.id);
  return path.join(src.runsRoot, run.id);
}

export async function readReport(
  src: DashboardSource,
  run: RunRow,
): Promise<RunReport | Unreadable | null> {
  if (!run.report_path) return null;
  const text = await readInside(src.runsRoot, path.join(runDir(src, run), "report.json"));
  if (!isText(text)) return text;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { problem: "report.json is not valid JSON" };
  }
  const parsed = RunReportSchema.safeParse(json);
  return parsed.success ? parsed.data : { problem: "report.json does not match the report schema" };
}

/** The spec notice of a run waiting at the spec gate (no report exists yet). */
export async function readSpecNotice(src: DashboardSource, run: RunRow): Promise<string | null> {
  const text = await readInside(src.runsRoot, path.join(runDir(src, run), "spec-approval.md"));
  return isText(text) ? text : null;
}

export type EvalView =
  | { kind: "suite"; summary: RepeatedSummary }
  | { kind: "markdown"; text: string }
  | { kind: "missing"; problem: string };

/** An eval's summary: `summary.json` of the suite, else its `summary.md` (e.g. memory A/B). */
export async function readEvalSummary(src: DashboardSource, e: EvalRow): Promise<EvalView> {
  if (!e.summary_path) return { kind: "missing", problem: "no summary recorded" };
  const dir = path.dirname(path.resolve(src.runsRoot, "..", e.summary_path));
  const json = await readInside(src.runsRoot, path.join(dir, "summary.json"));
  if (isText(json)) {
    try {
      const parsed = RepeatedSummarySchema.safeParse(JSON.parse(json));
      if (parsed.success) return { kind: "suite", summary: parsed.data };
    } catch {
      // not JSON: fall through to the markdown summary
    }
  }
  const md = await readInside(src.runsRoot, path.join(dir, "summary.md"));
  return isText(md) ? { kind: "markdown", text: md } : { kind: "missing", problem: md.problem };
}

/** Two evals are comparable only when they ran against the same baseline commit. */
export function comparable(a: EvalRow, b: EvalRow): { ok: true } | { ok: false; reason: string } {
  if (a.baseline_commit !== b.baseline_commit) {
    return {
      ok: false,
      reason: `different baselines: ${a.baseline_commit.slice(0, 12)} vs ${b.baseline_commit.slice(0, 12)}`,
    };
  }
  if (a.project_id !== b.project_id) {
    return { ok: false, reason: `different projects: ${a.project_id} vs ${b.project_id}` };
  }
  return { ok: true };
}
