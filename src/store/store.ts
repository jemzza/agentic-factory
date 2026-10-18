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
  /** The PR was merged on GitHub by hand, bypassing the factory's merge gate. */
  "merged_externally",
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
  project_id: z.string(),
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
  /** NULL for runs recorded before migration 004 whose counters could not be reconstructed. */
  gate_fix_cycles: z.number().int().nullable(),
  review_cycles: z.number().int().nullable(),
  /** Set by an eval: verified with no fix cycles. NULL until decided (and for interactive runs). */
  first_pass: z
    .union([z.literal(0), z.literal(1)])
    .nullable()
    .transform((v) => (v === null ? null : v === 1)),
  /** Human spec rejections; NULL for runs without a spec approval stage (Week 1). */
  spec_revisions: z.number().int().nullable(),
  /** GitHub issue / pull request of the run (NULL for CLI runs). */
  issue_number: z.number().int().nullable(),
  pr_number: z.number().int().nullable(),
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
  project_id: z.string(),
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
  project_id: z.string(),
  gate: z.enum(["spec", "merge"]),
  decision: z.enum(["approve", "reject", "merge", "close"]),
  actor: z.string(),
  channel: z.enum(["cli", "github", "auto"]),
  comment: z.string().nullable(),
  decided_at: z.string(),
});
export type ApprovalRow = z.output<typeof ApprovalRowSchema>;

export const BaselineRowSchema = z.object({
  id: z.number().int(),
  target: z.string(),
  project_id: z.string(),
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
  status: z.enum(["running", "completed", "cost_cap_reached", "error", "interrupted"]),
  repeat_count: z.number().int(),
  baseline_commit: z.string(),
  cost_cap_usd: z.number().nullable(),
  cost_usd: z.number(),
  summary_path: z.string().nullable(),
  project_id: z.string(),
  kind: z.enum(["run", "rescore"]),
  source_eval_id: z.string().nullable(),
});
export type EvalRow = z.output<typeof EvalRowSchema>;

export const GITHUB_EVENT_OUTCOMES = [
  "accepted",
  "executed",
  "invalid",
  "ignored_unauthorized",
  "ignored_stale",
  "ignored_not_applicable",
  "not_command",
  "factory_comment",
] as const;
export type GithubEventOutcome = (typeof GITHUB_EVENT_OUTCOMES)[number];
export type GithubEventKind = "issue" | "comment" | "pr";

export const GithubEventRowSchema = z.object({
  id: z.number().int(),
  project_id: z.string(),
  kind: z.enum(["issue", "comment", "pr"]),
  github_id: z.number().int(),
  number: z.number().int().nullable(),
  author: z.string().nullable(),
  outcome: z.enum(GITHUB_EVENT_OUTCOMES),
  run_id: z.string().nullable(),
  detail: z.string().nullable(),
  applied: z.union([z.literal(0), z.literal(1)]).transform((v) => v === 1),
  processed_at: z.string(),
});
export type GithubEventRow = z.output<typeof GithubEventRowSchema>;

export const SpecVersionRowSchema = z.object({
  run_id: z.string(),
  version: z.number().int(),
  hash: z.string(),
  spec_commit: z.string(),
  comment_id: z.number().int().nullable(),
  published_at: z.string(),
});
export type SpecVersionRow = z.output<typeof SpecVersionRowSchema>;

export const MEMORY_SOURCES = [
  "spec_rejection_comment",
  "review_issue_fixed",
  "merged_run",
  "manual",
] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

export const MemoryRowSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  text: z.string(),
  source: z.enum(MEMORY_SOURCES),
  run_id: z.string().nullable(),
  created_at: z.string(),
  embed_model: z.string(),
  index_id: z.string().nullable(),
  removed_at: z.string().nullable(),
  dedupe_key: z.string().nullable(),
});
export type MemoryRow = z.output<typeof MemoryRowSchema>;

export interface NewRun {
  id: string;
  /** Project from projects.yaml. */
  projectId: string;
  /** GitHub issue the run implements. */
  issueNumber?: number;
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
  gateFixCycles: number;
  reviewCycles: number;
  firstPass: boolean | null;
  specRevisions: number;
  issueNumber: number;
  prNumber: number;
}>;

const RUN_PATCH_COLUMNS: Record<keyof RunPatch, string> = {
  issueNumber: "issue_number",
  prNumber: "pr_number",
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
  gateFixCycles: "gate_fix_cycles",
  reviewCycles: "review_cycles",
  firstPass: "first_pass",
  specRevisions: "spec_revisions",
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
        `INSERT INTO runs (id, project_id, issue_number, task_id, mode, eval_id, eval_repeat, status,
           spec_approval, started_at, updated_at, budget_usd, roles_json, baseline_commit,
           gate_fix_cycles, review_cycles, spec_revisions)
         VALUES (@id, @projectId, @issueNumber, @taskId, @mode, @evalId, @evalRepeat, @status,
           @specApproval, @now, @now, @budgetUsd, @roles, @baselineCommit, 0, 0, @specRevisions)`,
      )
      .run({
        id: run.id,
        projectId: run.projectId,
        issueNumber: run.issueNumber ?? null,
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
        // A run with a spec approval stage starts with no rejections; Week 1 imports have none.
        specRevisions: run.specApproval ? 0 : null,
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
    filter: {
      taskId?: string;
      status?: StoredRunStatus;
      evalId?: string;
      projectId?: string;
      limit?: number;
    } = {},
  ): RunRow[] {
    const where: string[] = [];
    const params: Record<string, unknown> = { limit: filter.limit ?? 100 };
    if (filter.projectId) {
      where.push("project_id = @projectId");
      params["projectId"] = filter.projectId;
    }
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
    for (const [k, v] of entries) {
      params[k] =
        k === "statusMessage" ? this.redact(String(v)) : typeof v === "boolean" ? Number(v) : v;
    }
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

  /** Project of a run (events and approvals carry it too). */
  private projectOfRun(runId: string): string {
    const row = this.db.prepare("SELECT project_id FROM runs WHERE id = ?").get(runId) as
      { project_id: string } | undefined;
    if (!row) throw new Error(`run ${runId} not found`);
    return row.project_id;
  }

  appendEvent(
    runId: string,
    event: { kind: EventKind; node?: string | null; next?: string | null; payload?: unknown },
  ): void {
    this.db
      .prepare(
        `INSERT INTO events (run_id, project_id, ts, kind, node, next, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        this.projectOfRun(runId),
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
    /** Where the decision was made; default: `auto` for the auto actor, else `cli`. */
    channel?: "cli" | "github" | "auto";
  }): ApprovalRow {
    const info = this.db
      .prepare(
        `INSERT INTO approvals (run_id, project_id, gate, decision, actor, channel, comment,
           decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.runId,
        this.projectOfRun(a.runId),
        a.gate,
        a.decision,
        a.actor,
        a.channel ?? (a.actor === "auto" ? "auto" : "cli"),
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
        `INSERT INTO baselines (target, project_id, tag, commit_hash, previous_hash, actor, reason,
           created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        b.target,
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
    projectId: string;
    /** A rescore of `sourceEvalId` (hidden tests only, no agent calls). */
    rescoreOf?: string;
  }): EvalRow {
    this.db
      .prepare(
        `INSERT INTO evals (id, project_id, started_at, status, repeat_count, baseline_commit,
           cost_cap_usd, kind, source_eval_id)
         VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
      )
      .run(
        e.id,
        e.projectId,
        this.ts(),
        e.repeatCount,
        e.baselineCommit,
        e.costCapUsd,
        e.rescoreOf === undefined ? "run" : "rescore",
        e.rescoreOf ?? null,
      );
    return this.requireEval(e.id);
  }

  finishEval(
    id: string,
    r: {
      status: "completed" | "cost_cap_reached" | "error" | "interrupted";
      /** Total repeats of the eval (it can grow when a resume adds repeats). */
      repeatCount?: number;
      costUsd: number;
      summaryPath: string | null;
    },
  ): EvalRow {
    this.db
      .prepare(
        `UPDATE evals SET status = ?, finished_at = ?, cost_usd = ?, summary_path = ?,
           repeat_count = COALESCE(?, repeat_count) WHERE id = ?`,
      )
      .run(r.status, this.ts(), r.costUsd, r.summaryPath, r.repeatCount ?? null, id);
    return this.requireEval(id);
  }

  /** Marks an eval as running again (`npm run eval -- --resume`). */
  resumeEval(id: string): EvalRow {
    this.db.prepare("UPDATE evals SET status = 'running', finished_at = NULL WHERE id = ?").run(id);
    return this.requireEval(id);
  }

  getEval(id: string): EvalRow | null {
    const row = this.db.prepare("SELECT * FROM evals WHERE id = ?").get(id);
    return row === undefined ? null : EvalRowSchema.parse(row);
  }

  /** Most recent first. */
  listEvals(limit = 100): EvalRow[] {
    return this.db
      .prepare("SELECT * FROM evals ORDER BY started_at DESC, id DESC LIMIT ?")
      .all(limit)
      .map((r) => EvalRowSchema.parse(r));
  }

  private requireEval(id: string): EvalRow {
    const e = this.getEval(id);
    if (!e) throw new Error(`eval ${id} not found`);
    return e;
  }

  // ---- GitHub (factory:watch) ---------------------------------------------

  /** The decision about a GitHub object, if it was already processed. */
  getGithubEvent(
    projectId: string,
    kind: GithubEventKind,
    githubId: number,
  ): GithubEventRow | null {
    const row = this.db
      .prepare("SELECT * FROM github_events WHERE project_id = ? AND kind = ? AND github_id = ?")
      .get(projectId, kind, githubId);
    return row === undefined ? null : GithubEventRowSchema.parse(row);
  }

  /**
   * Records a decision about a GitHub object exactly once. Returns false if it was already
   * recorded (then nothing changes). Call inside the same transaction as its effect.
   */
  recordGithubEvent(e: {
    projectId: string;
    kind: GithubEventKind;
    githubId: number;
    number?: number | null;
    author?: string | null;
    outcome: GithubEventOutcome;
    runId?: string | null;
    detail?: string | null;
    applied?: boolean;
  }): boolean {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO github_events (project_id, kind, github_id, number, author, outcome,
           run_id, detail, applied, processed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.projectId,
        e.kind,
        e.githubId,
        e.number ?? null,
        e.author ?? null,
        e.outcome,
        e.runId ?? null,
        e.detail === undefined || e.detail === null ? null : this.redact(e.detail),
        e.applied === false ? 0 : 1,
        this.ts(),
      );
    return info.changes === 1;
  }

  markGithubEventApplied(id: number): void {
    this.db.prepare("UPDATE github_events SET applied = 1 WHERE id = ?").run(id);
  }

  /** Executed commands whose effect on the run was not completed (e.g. a crash). */
  listUnappliedGithubEvents(projectId: string): GithubEventRow[] {
    return this.db
      .prepare(
        "SELECT * FROM github_events WHERE project_id = ? AND applied = 0 AND outcome IN ('executed', 'accepted') ORDER BY id",
      )
      .all(projectId)
      .map((r) => GithubEventRowSchema.parse(r));
  }

  listGithubEvents(projectId: string): GithubEventRow[] {
    return this.db
      .prepare("SELECT * FROM github_events WHERE project_id = ? ORDER BY id")
      .all(projectId)
      .map((r) => GithubEventRowSchema.parse(r));
  }

  /** Records the next published spec version of a run (version = previous + 1). */
  recordSpecVersion(v: {
    runId: string;
    hash: string;
    specCommit: string;
    commentId: number | null;
    publishedAt: string;
  }): SpecVersionRow {
    const prev = this.db
      .prepare("SELECT MAX(version) v FROM spec_versions WHERE run_id = ?")
      .get(v.runId) as { v: number | null };
    const version = (prev.v ?? 0) + 1;
    this.db
      .prepare(
        `INSERT INTO spec_versions (run_id, version, hash, spec_commit, comment_id, published_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(v.runId, version, v.hash, v.specCommit, v.commentId, v.publishedAt);
    return {
      run_id: v.runId,
      version,
      hash: v.hash,
      spec_commit: v.specCommit,
      comment_id: v.commentId,
      published_at: v.publishedAt,
    };
  }

  setSpecVersionComment(runId: string, version: number, commentId: number): void {
    this.db
      .prepare("UPDATE spec_versions SET comment_id = ? WHERE run_id = ? AND version = ?")
      .run(commentId, runId, version);
  }

  listSpecVersions(runId: string): SpecVersionRow[] {
    return this.db
      .prepare("SELECT * FROM spec_versions WHERE run_id = ? ORDER BY version")
      .all(runId)
      .map((r) => SpecVersionRowSchema.parse(r));
  }

  /** Project ids that have runs, sorted. */
  listRunProjects(): string[] {
    return (
      this.db.prepare("SELECT DISTINCT project_id p FROM runs ORDER BY p").all() as { p: string }[]
    ).map((r) => r.p);
  }

  latestSpecVersion(runId: string): SpecVersionRow | null {
    const row = this.db
      .prepare("SELECT * FROM spec_versions WHERE run_id = ? ORDER BY version DESC LIMIT 1")
      .get(runId);
    return row === undefined ? null : SpecVersionRowSchema.parse(row);
  }

  getCursor(projectId: string, stream: string): string | null {
    const row = this.db
      .prepare("SELECT since FROM gh_cursors WHERE project_id = ? AND stream = ?")
      .get(projectId, stream) as { since: string } | undefined;
    return row?.since ?? null;
  }

  setCursor(projectId: string, stream: string, since: string): void {
    this.db
      .prepare(
        `INSERT INTO gh_cursors (project_id, stream, since) VALUES (?, ?, ?)
         ON CONFLICT (project_id, stream) DO UPDATE SET since = excluded.since`,
      )
      .run(projectId, stream, since);
  }

  /** The latest run of a GitHub issue (a /retry creates a new run for the same issue). */
  latestRunForIssue(projectId: string, issue: number): RunRow | null {
    const row = this.db
      .prepare(
        "SELECT * FROM runs WHERE project_id = ? AND issue_number = ? ORDER BY started_at DESC, id DESC LIMIT 1",
      )
      .get(projectId, issue);
    return row === undefined ? null : RunRowSchema.parse(row);
  }

  runForPull(projectId: string, pr: number): RunRow | null {
    const row = this.db
      .prepare("SELECT * FROM runs WHERE project_id = ? AND pr_number = ? ORDER BY id DESC LIMIT 1")
      .get(projectId, pr);
    return row === undefined ? null : RunRowSchema.parse(row);
  }

  /** Runs of GitHub issues in a project with one of `statuses`. */
  listGithubRuns(projectId: string, statuses: readonly StoredRunStatus[]): RunRow[] {
    return this.db
      .prepare(
        `SELECT * FROM runs WHERE project_id = ? AND issue_number IS NOT NULL
           AND status IN (${statuses.map(() => "?").join(", ")}) ORDER BY id`,
      )
      .all(projectId, ...statuses)
      .map((r) => RunRowSchema.parse(r));
  }

  /**
   * Takes a named process lock. A lock held by a dead local process is taken over; a live one
   * makes this return its holder.
   */
  acquireNamedLock(
    name: string,
    holder: string = processLockId(),
  ): { ok: true } | { ok: false; holder: string } {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT holder FROM locks WHERE name = ?").get(name) as
        { holder: string } | undefined;
      if (row && row.holder !== holder && isProcessAlive(row.holder)) {
        return { ok: false as const, holder: row.holder };
      }
      this.db
        .prepare(
          `INSERT INTO locks (name, holder, acquired_at) VALUES (?, ?, ?)
           ON CONFLICT (name) DO UPDATE SET holder = excluded.holder, acquired_at = excluded.acquired_at`,
        )
        .run(name, holder, this.ts());
      return { ok: true as const };
    })();
  }

  releaseNamedLock(name: string, holder: string = processLockId()): void {
    this.db.prepare("DELETE FROM locks WHERE name = ? AND holder = ?").run(name, holder);
  }

  /** factory:watch retries the issue of an infra_error run once `notBefore` has passed. */
  scheduleWatchRetry(r: {
    runId: string;
    projectId: string;
    issueNumber: number;
    notBefore: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO watch_retries (run_id, project_id, issue_number, not_before) VALUES (?, ?, ?, ?)
         ON CONFLICT (run_id) DO UPDATE SET not_before = excluded.not_before`,
      )
      .run(r.runId, r.projectId, r.issueNumber, r.notBefore);
  }

  dueWatchRetries(projectId: string, now: string): { run_id: string; issue_number: number }[] {
    return this.db
      .prepare(
        "SELECT run_id, issue_number FROM watch_retries WHERE project_id = ? AND not_before <= ? ORDER BY not_before",
      )
      .all(projectId, now) as { run_id: string; issue_number: number }[];
  }

  pendingWatchRetries(projectId: string): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) n FROM watch_retries WHERE project_id = ?")
        .get(projectId) as {
        n: number;
      }
    ).n;
  }

  deleteWatchRetry(runId: string): void {
    this.db.prepare("DELETE FROM watch_retries WHERE run_id = ?").run(runId);
  }

  // ---- project memory (canonical records; the vector index is derived) ---------

  insertMemory(m: {
    id: string;
    projectId: string;
    text: string;
    source: MemorySource;
    runId: string | null;
    embedModel: string;
    dedupeKey?: string | null;
  }): { row: MemoryRow; created: boolean } {
    if (m.dedupeKey) {
      const existing = this.db
        .prepare("SELECT * FROM memories WHERE dedupe_key = ?")
        .get(m.dedupeKey);
      if (existing !== undefined) return { row: MemoryRowSchema.parse(existing), created: false };
    }
    this.db
      .prepare(
        `INSERT INTO memories (id, project_id, text, source, run_id, created_at, embed_model,
           dedupe_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.id,
        m.projectId,
        this.redact(m.text),
        m.source,
        m.runId,
        this.ts(),
        m.embedModel,
        m.dedupeKey ?? null,
      );
    return { row: this.requireMemory(m.projectId, m.id), created: true };
  }

  getMemory(projectId: string, id: string): MemoryRow | null {
    const row = this.db
      .prepare("SELECT * FROM memories WHERE project_id = ? AND id = ?")
      .get(projectId, id);
    return row === undefined ? null : MemoryRowSchema.parse(row);
  }

  private requireMemory(projectId: string, id: string): MemoryRow {
    const m = this.getMemory(projectId, id);
    if (!m) throw new Error(`memory ${id} not found in project ${projectId}`);
    return m;
  }

  /** Active records of a project (or of all projects), oldest first. */
  listMemories(projectId: string | null, opts: { includeRemoved?: boolean } = {}): MemoryRow[] {
    const where = [
      ...(projectId === null ? [] : ["project_id = ?"]),
      ...(opts.includeRemoved ? [] : ["removed_at IS NULL"]),
    ];
    return this.db
      .prepare(
        `SELECT * FROM memories ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, id`,
      )
      .all(...(projectId === null ? [] : [projectId]))
      .map((r) => MemoryRowSchema.parse(r));
  }

  setMemoryIndexed(id: string, indexId: string | null, embedModel: string): void {
    this.db
      .prepare("UPDATE memories SET index_id = ?, embed_model = ? WHERE id = ?")
      .run(indexId, embedModel, id);
  }

  removeMemory(projectId: string, id: string): boolean {
    const info = this.db
      .prepare(
        "UPDATE memories SET removed_at = ? WHERE project_id = ? AND id = ? AND removed_at IS NULL",
      )
      .run(this.ts(), projectId, id);
    return info.changes === 1;
  }

  getMemoryIndex(name: string): { embed_model: string; dims: number; built_at: string } | null {
    const row = this.db.prepare("SELECT * FROM memory_index WHERE name = ?").get(name) as
      { embed_model: string; dims: number; built_at: string } | undefined;
    return row ?? null;
  }

  setMemoryIndex(name: string, embedModel: string, dims: number): void {
    this.db
      .prepare(
        `INSERT INTO memory_index (name, embed_model, dims, built_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET embed_model = excluded.embed_model,
           dims = excluded.dims, built_at = excluded.built_at`,
      )
      .run(name, embedModel, dims, this.ts());
  }
}
