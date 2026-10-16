import os from "node:os";
import { z } from "zod";
import { RUN_STATUSES } from "../schemas/report.js";
import type { Db } from "./db.js";
import { createRedactor, type Redactor } from "./redact.js";

/** Week 1 terminal statuses plus the workflow lifecycle states. */
export const STORED_RUN_STATUSES = [
  "running",
  "awaiting_spec_approval",
  "awaiting_merge_approval",
  "merged",
  "closed",
  ...RUN_STATUSES,
] as const;
export type StoredRunStatus = (typeof STORED_RUN_STATUSES)[number];

const RoleBindingSchema = z.strictObject({ runtime: z.string(), model: z.string() });
export const RolesSchema = z.record(z.string(), RoleBindingSchema);
export type Roles = z.infer<typeof RolesSchema>;

const jsonText = <S extends z.ZodType>(schema: S) =>
  z.string().transform((s, ctx) => {
    try {
      const parsed = schema.safeParse(JSON.parse(s));
      if (parsed.success) return parsed.data;
      ctx.addIssue({ code: "custom", message: parsed.error.message });
    } catch {
      ctx.addIssue({ code: "custom", message: "invalid JSON" });
    }
    return z.NEVER;
  });

export const RunRowSchema = z.object({
  id: z.string(),
  task_id: z.string(),
  mode: z.enum(["interactive", "eval"]),
  eval_id: z.string().nullable(),
  eval_repeat: z.number().int().nullable(),
  status: z.enum(STORED_RUN_STATUSES),
  status_message: z.string(),
  spec_approval: z.enum(["manual", "auto"]).nullable(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
  updated_at: z.string(),
  cost_usd: z.number(),
  budget_usd: z.number(),
  unknown_cost_steps: z.number().int(),
  fix_cycles: z.number().int(),
  roles_json: jsonText(RolesSchema),
  baseline_commit: z.string().nullable(),
  worktree_path: z.string().nullable(),
  branch: z.string().nullable(),
  base_commit: z.string().nullable(),
  head_commit: z.string().nullable(),
  report_path: z.string().nullable(),
  locked_by: z.string().nullable(),
  /** NULL for runs recorded before migration 002. */
  active_duration_ms: z.number().int().nullable(),
  wall_duration_ms: z.number().int().nullable(),
});
export type RunRow = z.output<typeof RunRowSchema>;

export const StepRowSchema = z.object({
  id: z.number().int(),
  run_id: z.string(),
  node: z.string(),
  cycle: z.number().int(),
  attempt: z.number().int(),
  status: z.enum(["running", "ok", "failed", "abandoned", "interrupted"]),
  started_at: z.string(),
  finished_at: z.string().nullable(),
  duration_ms: z.number().int().nullable(),
  cost_usd: z.number().nullable(),
  runtime: z.string().nullable(),
  model: z.string().nullable(),
  log_path: z.string().nullable(),
  error_kind: z.string().nullable(),
  error_message: z.string().nullable(),
});
export type StepRow = z.output<typeof StepRowSchema>;

export const EVENT_KINDS = [
  "node_start",
  "node_end",
  "transition",
  "interrupt",
  "resume",
  "status",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const EventRowSchema = z.object({
  id: z.number().int(),
  run_id: z.string(),
  ts: z.string(),
  kind: z.enum(EVENT_KINDS),
  node: z.string().nullable(),
  next: z.string().nullable(),
  payload: z.string().nullable(),
});
export type EventRow = z.output<typeof EventRowSchema>;

export const ApprovalRowSchema = z.object({
  id: z.number().int(),
  run_id: z.string(),
  gate: z.enum(["spec", "merge"]),
  decision: z.enum(["approve", "reject", "merge", "close"]),
  actor: z.string(),
  comment: z.string().nullable(),
  decided_at: z.string(),
});
export type ApprovalRow = z.output<typeof ApprovalRowSchema>;

export const BaselineRowSchema = z.object({
  id: z.number().int(),
  target: z.string(),
  tag: z.string(),
  commit_hash: z.string(),
  previous_hash: z.string().nullable(),
  actor: z.string(),
  reason: z.string().nullable(),
  created_at: z.string(),
});
export type BaselineRow = z.output<typeof BaselineRowSchema>;

export const EvalRowSchema = z.object({
  id: z.string(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
  status: z.enum(["running", "completed", "cost_cap_reached", "error"]),
  repeat_count: z.number().int(),
  baseline_commit: z.string(),
  cost_cap_usd: z.number().nullable(),
  cost_usd: z.number(),
  summary_path: z.string().nullable(),
});
export type EvalRow = z.output<typeof EvalRowSchema>;

export interface NewRun {
  id: string;
  taskId: string;
  mode: "interactive" | "eval";
  budgetUsd: number;
  roles: Roles;
  specApproval?: "manual" | "auto" | null;
  evalId?: string | null;
  evalRepeat?: number | null;
  baselineCommit?: string | null;
  status?: StoredRunStatus;
  startedAt?: string;
}

export type RunPatch = Partial<{
  status: StoredRunStatus;
  statusMessage: string;
  finishedAt: string | null;
  costUsd: number;
  unknownCostSteps: number;
  fixCycles: number;
  worktreePath: string;
  branch: string;
  baseCommit: string;
  headCommit: string | null;
  reportPath: string;
  specApproval: "manual" | "auto";
  activeDurationMs: number;
  wallDurationMs: number;
}>;

const RUN_PATCH_COLUMNS: Record<keyof RunPatch, string> = {
  status: "status",
  statusMessage: "status_message",
  finishedAt: "finished_at",
  costUsd: "cost_usd",
  unknownCostSteps: "unknown_cost_steps",
  fixCycles: "fix_cycles",
  worktreePath: "worktree_path",
  branch: "branch",
  baseCommit: "base_commit",
  headCommit: "head_commit",
  reportPath: "report_path",
  specApproval: "spec_approval",
  activeDurationMs: "active_duration_ms",
  wallDurationMs: "wall_duration_ms",
};

export class RunLockedError extends Error {
  constructor(
    readonly runId: string,
    readonly lockedBy: string,
  ) {
    super(`run ${runId} is being driven by another process (${lockedBy})`);
    this.name = "RunLockedError";
  }
}

export function processLockId(): string {
  return `${os.hostname()}:${process.pid}`;
}

function isProcessAlive(lockId: string): boolean {
  const [host, pidText] = lockId.split(":");
  if (host !== os.hostname()) return true; // cannot check another host: assume alive
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Persistence for runs and their history. The database is the source of truth;
 * report.json / report.md are artifacts derived from it. Every value written to
 * `events.payload` and error messages passes through the redactor.
 */
export class Store {
  private readonly redact: Redactor;

  constructor(
    readonly db: Db,
    opts: { secrets?: readonly string[]; now?: () => Date } = {},
  ) {
    this.redact = createRedactor(opts.secrets ?? []);
    this.now = opts.now ?? (() => new Date());
  }

  private readonly now: () => Date;
  private ts(): string {
    return this.now().toISOString();
  }

  // ---- runs ---------------------------------------------------------------

  createRun(run: NewRun): RunRow {
    const now = run.startedAt ?? this.ts();
    this.db
      .prepare(
        `INSERT INTO runs (id, task_id, mode, eval_id, eval_repeat, status, spec_approval, started_at,
           updated_at, budget_usd, roles_json, baseline_commit)
         VALUES (@id, @taskId, @mode, @evalId, @evalRepeat, @status, @specApproval, @now, @now, @budgetUsd,
           @roles, @baselineCommit)`,
      )
      .run({
        id: run.id,
        taskId: run.taskId,
        mode: run.mode,
        evalId: run.evalId ?? null,
        evalRepeat: run.evalRepeat ?? null,
        status: run.status ?? "running",
        specApproval: run.specApproval ?? null,
        now,
        budgetUsd: run.budgetUsd,
        roles: JSON.stringify(RolesSchema.parse(run.roles)),
        baselineCommit: run.baselineCommit ?? null,
      });
    return this.requireRun(run.id);
  }

  getRun(id: string): RunRow | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
    return row === undefined ? null : RunRowSchema.parse(row);
  }

  requireRun(id: string): RunRow {
    const run = this.getRun(id);
    if (!run) throw new Error(`run ${id} not found`);
    return run;
  }

  listRuns(
    filter: { taskId?: string; status?: StoredRunStatus; evalId?: string; limit?: number } = {},
  ): RunRow[] {
    const where: string[] = [];
    const params: Record<string, unknown> = { limit: filter.limit ?? 100 };
    if (filter.taskId) {
      where.push("task_id = @taskId");
      params["taskId"] = filter.taskId;
    }
    if (filter.status) {
      where.push("status = @status");
      params["status"] = filter.status;
    }
    if (filter.evalId) {
      where.push("eval_id = @evalId");
      params["evalId"] = filter.evalId;
    }
    const sql = `SELECT * FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY started_at DESC, id DESC LIMIT @limit`;
    return this.db
      .prepare(sql)
      .all(params)
      .map((r) => RunRowSchema.parse(r));
  }

  updateRun(id: string, patch: RunPatch): RunRow {
    const entries = Object.entries(patch) as [keyof RunPatch, unknown][];
    const sets = entries.map(([k]) => `${RUN_PATCH_COLUMNS[k]} = @${k}`);
    const params: Record<string, unknown> = { id, updatedAt: this.ts() };
    for (const [k, v] of entries) params[k] = k === "statusMessage" ? this.redact(String(v)) : v;
    const res = this.db
      .prepare(`UPDATE runs SET ${[...sets, "updated_at = @updatedAt"].join(", ")} WHERE id = @id`)
      .run(params);
    if (res.changes !== 1) throw new Error(`run ${id} not found`);
    if (patch.status !== undefined) {
      this.appendEvent(id, {
        kind: "status",
        payload: { status: patch.status, message: patch.statusMessage ?? "" },
      });
    }
    return this.requireRun(id);
  }

  /**
   * Marks the run as driven by this process. A lock held by a dead local process is taken
   * over; a live one raises RunLockedError.
   */
  acquireLock(id: string, lockId: string = processLockId()): void {
    const tx = this.db.transaction(() => {
      const run = this.requireRun(id);
      if (run.locked_by && run.locked_by !== lockId && isProcessAlive(run.locked_by)) {
        throw new RunLockedError(id, run.locked_by);
      }
      this.db.prepare("UPDATE runs SET locked_by = ? WHERE id = ?").run(lockId, id);
    });
    tx.immediate();
  }

  releaseLock(id: string, lockId: string = processLockId()): void {
    this.db
      .prepare("UPDATE runs SET locked_by = NULL WHERE id = ? AND locked_by = ?")
      .run(id, lockId);
  }

  // ---- steps --------------------------------------------------------------

  /** Starts a step; the attempt number is one more than any previous attempt of the same node/cycle. */
  startStep(
    runId: string,
    node: string,
    cycle = 0,
    extra: { runtime?: string; model?: string } = {},
  ): StepRow {
    const tx = this.db.transaction(() => {
      const prev = this.db
        .prepare("SELECT MAX(attempt) AS a FROM steps WHERE run_id = ? AND node = ? AND cycle = ?")
        .get(runId, node, cycle) as { a: number | null };
      const info = this.db
        .prepare(
          `INSERT INTO steps (run_id, node, cycle, attempt, status, started_at, runtime, model)
           VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`,
        )
        .run(
          runId,
          node,
          cycle,
          (prev.a ?? 0) + 1,
          this.ts(),
          extra.runtime ?? null,
          extra.model ?? null,
        );
      return Number(info.lastInsertRowid);
    });
    const id = tx.immediate();
    this.appendEvent(runId, { kind: "node_start", node, payload: { cycle } });
    return this.requireStep(id);
  }

  finishStep(
    stepId: number,
    result: {
      status: "ok" | "failed" | "interrupted";
      costUsd?: number | null;
      logPath?: string | null;
      error?: { kind: string; message: string } | null;
    },
  ): StepRow {
    const step = this.requireStep(stepId);
    const finished = this.now();
    this.db
      .prepare(
        `UPDATE steps SET status = ?, finished_at = ?, duration_ms = ?, cost_usd = ?, log_path = ?,
           error_kind = ?, error_message = ? WHERE id = ?`,
      )
      .run(
        result.status,
        finished.toISOString(),
        Math.max(0, finished.getTime() - Date.parse(step.started_at)),
        result.costUsd ?? null,
        result.logPath ?? null,
        result.error?.kind ?? null,
        result.error ? this.redact(result.error.message) : null,
        stepId,
      );
    this.appendEvent(step.run_id, {
      kind: "node_end",
      node: step.node,
      payload: { cycle: step.cycle, attempt: step.attempt, status: result.status },
    });
    return this.requireStep(stepId);
  }

  /** On resume: steps left `running` by a dead process become `abandoned`. Returns how many. */
  abandonRunningSteps(runId: string): number {
    return this.db
      .prepare(
        "UPDATE steps SET status = 'abandoned', finished_at = ? WHERE run_id = ? AND status = 'running'",
      )
      .run(this.ts(), runId).changes;
  }

  listSteps(runId: string): StepRow[] {
    return this.db
      .prepare("SELECT * FROM steps WHERE run_id = ? ORDER BY id")
      .all(runId)
      .map((r) => StepRowSchema.parse(r));
  }

  private requireStep(id: number): StepRow {
    return StepRowSchema.parse(this.db.prepare("SELECT * FROM steps WHERE id = ?").get(id));
  }

  // ---- events -------------------------------------------------------------

  appendEvent(
    runId: string,
    event: { kind: EventKind; node?: string | null; next?: string | null; payload?: unknown },
  ): void {
    this.db
      .prepare(
        "INSERT INTO events (run_id, ts, kind, node, next, payload) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        runId,
        this.ts(),
        event.kind,
        event.node ?? null,
        event.next ?? null,
        event.payload === undefined ? null : this.redact(JSON.stringify(event.payload)),
      );
  }

  listEvents(runId: string): EventRow[] {
    return this.db
      .prepare("SELECT * FROM events WHERE run_id = ? ORDER BY id")
      .all(runId)
      .map((r) => EventRowSchema.parse(r));
  }

  // ---- approvals ----------------------------------------------------------

  recordApproval(a: {
    runId: string;
    gate: "spec" | "merge";
    decision: "approve" | "reject" | "merge" | "close";
    actor: string;
    comment?: string | null;
  }): ApprovalRow {
    const info = this.db
      .prepare(
        "INSERT INTO approvals (run_id, gate, decision, actor, comment, decided_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        a.runId,
        a.gate,
        a.decision,
        a.actor,
        a.comment ? this.redact(a.comment) : null,
        this.ts(),
      );
    return ApprovalRowSchema.parse(
      this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(info.lastInsertRowid),
    );
  }

  listApprovals(runId: string): ApprovalRow[] {
    return this.db
      .prepare("SELECT * FROM approvals WHERE run_id = ? ORDER BY id")
      .all(runId)
      .map((r) => ApprovalRowSchema.parse(r));
  }

  // ---- baselines ----------------------------------------------------------

  recordBaseline(b: {
    target: string;
    tag: string;
    commitHash: string;
    previousHash?: string | null;
    actor: string;
    reason?: string | null;
  }): BaselineRow {
    const info = this.db
      .prepare(
        `INSERT INTO baselines (target, tag, commit_hash, previous_hash, actor, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        b.target,
        b.tag,
        b.commitHash,
        b.previousHash ?? null,
        b.actor,
        b.reason ?? null,
        this.ts(),
      );
    return BaselineRowSchema.parse(
      this.db.prepare("SELECT * FROM baselines WHERE id = ?").get(info.lastInsertRowid),
    );
  }

  latestBaseline(target: string): BaselineRow | null {
    const row = this.db
      .prepare("SELECT * FROM baselines WHERE target = ? ORDER BY id DESC LIMIT 1")
      .get(target);
    return row === undefined ? null : BaselineRowSchema.parse(row);
  }

  // ---- evals --------------------------------------------------------------

  createEval(e: {
    id: string;
    repeatCount: number;
    baselineCommit: string;
    costCapUsd: number | null;
  }): EvalRow {
    this.db
      .prepare(
        `INSERT INTO evals (id, started_at, status, repeat_count, baseline_commit, cost_cap_usd)
         VALUES (?, ?, 'running', ?, ?, ?)`,
      )
      .run(e.id, this.ts(), e.repeatCount, e.baselineCommit, e.costCapUsd);
    return this.requireEval(e.id);
  }

  finishEval(
    id: string,
    r: {
      status: "completed" | "cost_cap_reached" | "error";
      costUsd: number;
      summaryPath: string | null;
    },
  ): EvalRow {
    this.db
      .prepare(
        "UPDATE evals SET status = ?, finished_at = ?, cost_usd = ?, summary_path = ? WHERE id = ?",
      )
      .run(r.status, this.ts(), r.costUsd, r.summaryPath, id);
    return this.requireEval(id);
  }

  getEval(id: string): EvalRow | null {
    const row = this.db.prepare("SELECT * FROM evals WHERE id = ?").get(id);
    return row === undefined ? null : EvalRowSchema.parse(row);
  }

  private requireEval(id: string): EvalRow {
    const e = this.getEval(id);
    if (!e) throw new Error(`eval ${id} not found`);
    return e;
  }
}
