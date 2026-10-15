import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { RunReportSchema, type RunReport } from "../schemas/report.js";
import type { Store } from "./store.js";

export interface ImportResult {
  imported: string[];
  skipped: string[];
  invalid: { file: string; error: string }[];
}

async function findReports(runsDir: string): Promise<{ file: string; evalId: string | null }[]> {
  const out: { file: string; evalId: string | null }[] = [];
  const entries = await readdir(runsDir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(runsDir, e.name);
    if (e.name.startsWith("eval-")) {
      for (const sub of await readdir(dir, { withFileTypes: true })) {
        if (sub.isDirectory())
          out.push({ file: path.join(dir, sub.name, "report.json"), evalId: e.name });
      }
    } else {
      out.push({ file: path.join(dir, "report.json"), evalId: null });
    }
  }
  return out;
}

function insertReport(
  store: Store,
  report: RunReport,
  reportPath: string,
  evalId: string | null,
): void {
  const baseline = report.target?.baseCommit ?? null;
  if (evalId && !store.getEval(evalId) && baseline) {
    store.createEval({ id: evalId, repeatCount: 1, baselineCommit: baseline, costCapUsd: null });
  }
  store.createRun({
    id: report.runId,
    taskId: report.task.id,
    mode: evalId ? "eval" : "interactive",
    budgetUsd: report.cost.budgetUsd,
    roles: Object.fromEntries(
      Object.entries(report.models).map(([role, model]) => [
        role,
        { runtime: report.runtime, model },
      ]),
    ),
    evalId: evalId && store.getEval(evalId) ? evalId : null,
    baselineCommit: baseline,
    startedAt: report.startedAt,
  });
  for (const step of report.steps) {
    if (step.kind === "snapshot") continue;
    const node = step.kind === "agent" ? step.role : "gate";
    const row = store.startStep(report.runId, node, step.cycle);
    store.finishStep(row.id, {
      status:
        step.kind === "agent" ? (step.ok ? "ok" : "failed") : step.result.passed ? "ok" : "failed",
      costUsd: step.kind === "agent" ? step.costUsd : null,
      logPath: step.kind === "agent" ? step.rawLogPath : null,
      error: step.kind === "agent" ? step.error : null,
    });
  }
  store.updateRun(report.runId, {
    status: report.status,
    statusMessage: report.message,
    finishedAt: report.finishedAt,
    costUsd: report.cost.totalUsd,
    unknownCostSteps: report.cost.unknownCostSteps,
    fixCycles: report.fixCycles,
    ...(report.worktree
      ? {
          worktreePath: report.worktree.path,
          branch: report.worktree.branch,
          headCommit: report.worktree.headCommit,
        }
      : {}),
    ...(report.target ? { baseCommit: report.target.baseCommit } : {}),
    reportPath: reportPath.replace(/report\.json$/, "report.md"),
  });
}

/**
 * Imports Week 1 run reports (`runs/<runId>/report.json`, `runs/eval-*\/<runId>/report.json`)
 * into the database. Runs already present are skipped, so the import can be repeated.
 * Each report is validated with the RunReport schema; invalid files are listed, not guessed.
 */
export async function importRunReports(store: Store, runsDir: string): Promise<ImportResult> {
  const result: ImportResult = { imported: [], skipped: [], invalid: [] };
  for (const { file, evalId } of await findReports(runsDir)) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, "utf8"));
    } catch {
      continue; // directory without a report (e.g. smoke runs)
    }
    const parsed = RunReportSchema.safeParse(raw);
    if (!parsed.success) {
      result.invalid.push({ file, error: parsed.error.message.slice(0, 300) });
      continue;
    }
    if (store.getRun(parsed.data.runId)) {
      result.skipped.push(parsed.data.runId);
      continue;
    }
    store.db.transaction(() => {
      insertReport(store, parsed.data, file, evalId);
    })();
    result.imported.push(parsed.data.runId);
  }
  return result;
}
