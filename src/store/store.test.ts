import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FACTORY_ROOT } from "../paths.js";
import { loadMigrations, migrate, openDb, type Db } from "./db.js";
import { createRedactor, MASK, secretsFromEnv } from "./redact.js";
import { RunLockedError, Store } from "./store.js";

const SECRET = "sk-test-0123456789abcdef";
const ROLES = {
  planner: { runtime: "claude-code", model: "opus" },
  developer: { runtime: "claude-code", model: "opus" },
  reviewer: { runtime: "opencode", model: "openai/gpt-x" },
};

let dir: string;
let db: Db;
let store: Store;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "factory-store-test-"));
  db = openDb(path.join(dir, "factory.db"));
  clock = Date.parse("2026-10-15T10:00:00.000Z");
  store = new Store(db, {
    secrets: [SECRET],
    now: () => new Date((clock += 1000)),
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const newRun = (id = "run-1") =>
  store.createRun({
    id,
    projectId: "p",
    taskId: "complete-task",
    mode: "interactive",
    budgetUsd: 1,
    roles: ROLES,
  });

describe("migrations", () => {
  it("creates all tables and records the applied version", () => {
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((t) => t.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "approvals",
        "baselines",
        "evals",
        "events",
        "runs",
        "schema_migrations",
        "steps",
      ]),
    );
    expect(db.prepare("SELECT version, name FROM schema_migrations").all()).toEqual([
      { version: 1, name: "init" },
      { version: 2, name: "run_durations" },
      { version: 3, name: "eval_interrupted" },
      { version: 4, name: "cycle_budgets" },
      { version: 5, name: "eval_rescore" },
      { version: 6, name: "project_id" },
    ]);
  });

  it("is idempotent", () => {
    expect(migrate(db)).toEqual([]);
  });

  it("refuses an applied migration whose file changed", () => {
    const [first] = loadMigrations();
    if (!first) throw new Error("no migrations");
    expect(() =>
      migrate(db, [{ ...first, sql: first.sql + "\n-- edited", checksum: "different" }]),
    ).toThrow(/modified after being applied/);
  });

  it("applies migrations in order on a fresh database and rejects gaps in numbering", () => {
    const fresh = new Database(":memory:");
    expect(migrate(fresh)).toEqual([1, 2, 3, 4, 5, 6]);
    fresh.close();
    const badDir = mkdtempSync(path.join(dir, "bad-"));
    writeFileSync(path.join(badDir, "001_a.sql"), "SELECT 1;");
    writeFileSync(path.join(badDir, "003_c.sql"), "SELECT 1;");
    expect(() => loadMigrations(badDir)).toThrow(/without gaps/);
  });

  it("migration 002 keeps runs recorded before it readable, with NULL durations", () => {
    const old = new Database(":memory:");
    const [m1, m2] = loadMigrations();
    if (!m1 || !m2) throw new Error("expected migrations 001 and 002");
    migrate(old, [m1]);
    old
      .prepare(
        `INSERT INTO runs (id, task_id, mode, status, started_at, updated_at, budget_usd, roles_json)
         VALUES ('old-run', 't', 'eval', 'success', '2026-10-15T00:00:00Z', '2026-10-15T00:00:00Z', 1, '{}')`,
      )
      .run();
    expect(migrate(old, [m1, m2])).toEqual([2]);
    migrate(old); // the Store reads a fully migrated database
    const row = new Store(old).requireRun("old-run");
    expect(row).toMatchObject({
      status: "success",
      active_duration_ms: null,
      wall_duration_ms: null,
    });
    old.close();
  });

  it("migration 005 marks existing evals as runs and records rescores with their source", () => {
    const old = new Database(":memory:");
    old.pragma("foreign_keys = ON");
    migrate(old, loadMigrations().slice(0, 4));
    old
      .prepare(
        `INSERT INTO evals (id, started_at, status, repeat_count, baseline_commit, cost_usd)
         VALUES ('eval-old', '2026-10-17T00:00:00Z', 'completed', 3, 'c3e', 17.93)`,
      )
      .run();
    expect(migrate(old)).toEqual([5, 6]);
    const s = new Store(old);
    expect(s.getEval("eval-old")).toMatchObject({ kind: "run", source_eval_id: null });
    s.createEval({
      id: "eval-old-rescore-1",
      repeatCount: 3,
      baselineCommit: "c3e",
      costCapUsd: null,
      projectId: "p",
      rescoreOf: "eval-old",
    });
    expect(s.getEval("eval-old-rescore-1")).toMatchObject({
      kind: "rescore",
      source_eval_id: "eval-old",
    });
    old.close();
  });

  it("migration 006 assigns every existing row to taskflow and new rows carry their project", () => {
    const old = new Database(":memory:");
    old.pragma("foreign_keys = ON");
    migrate(old, loadMigrations().slice(0, 5));
    old
      .prepare(
        `INSERT INTO runs (id, task_id, mode, status, started_at, updated_at, budget_usd, roles_json)
         VALUES ('old', 't', 'interactive', 'merged', 'x', 'x', 1, '{}')`,
      )
      .run();
    old
      .prepare(
        `INSERT INTO approvals (run_id, gate, decision, actor, decided_at)
         VALUES ('old', 'spec', 'approve', 'alice', 'x')`,
      )
      .run();
    old
      .prepare(
        `INSERT INTO baselines (target, tag, commit_hash, actor, created_at)
         VALUES ('taskflow', 'factory-baseline', 'c3e', 'factory', 'x')`,
      )
      .run();
    expect(migrate(old)).toEqual([6]);
    const s = new Store(old);
    expect(s.requireRun("old").project_id).toBe("taskflow");
    expect(s.listApprovals("old")[0]?.project_id).toBe("taskflow");
    s.createRun({
      id: "new",
      projectId: "ledgerlite",
      taskId: "t",
      mode: "interactive",
      budgetUsd: 1,
      roles: ROLES,
    });
    s.appendEvent("new", { kind: "status", payload: { x: 1 } });
    s.recordApproval({ runId: "new", gate: "spec", decision: "approve", actor: "bob" });
    expect(s.requireRun("new").project_id).toBe("ledgerlite");
    expect(s.listEvents("new")[0]?.project_id).toBe("ledgerlite");
    expect(s.listApprovals("new")[0]?.project_id).toBe("ledgerlite");
    old.close();
  });

  it("migration 003 rebuilds evals with the interrupted status, keeping rows and run references", () => {
    const old = new Database(":memory:");
    old.pragma("foreign_keys = ON");
    const [m1, m2, m3] = loadMigrations();
    if (!m1 || !m2 || !m3) throw new Error("expected migrations 001–003");
    migrate(old, [m1, m2]);
    old
      .prepare(
        `INSERT INTO evals (id, started_at, status, repeat_count, baseline_commit, cost_usd)
         VALUES ('eval-old', '2026-10-16T00:00:00Z', 'completed', 1, 'c3e', 6.03)`,
      )
      .run();
    old
      .prepare(
        `INSERT INTO runs (id, task_id, mode, eval_id, status, started_at, updated_at, budget_usd, roles_json)
         VALUES ('r1', 't', 'eval', 'eval-old', 'success', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z', 1, '{}')`,
      )
      .run();
    expect(migrate(old, [m1, m2, m3])).toEqual([3]);
    expect(old.pragma("foreign_key_check")).toEqual([]);
    migrate(old); // the Store reads a fully migrated database
    const s = new Store(old);
    expect(s.getEval("eval-old")).toMatchObject({ status: "completed", cost_usd: 6.03 });
    expect(s.requireRun("r1")).toMatchObject({ eval_id: "eval-old" });
    expect(
      s.finishEval("eval-old", {
        status: "interrupted",
        repeatCount: 3,
        costUsd: 7,
        summaryPath: null,
      }),
    ).toMatchObject({ status: "interrupted", repeat_count: 3 });
    expect(s.resumeEval("eval-old")).toMatchObject({ status: "running", finished_at: null });
    // The FK from runs still points at the rebuilt table.
    expect(() =>
      old
        .prepare(
          `INSERT INTO runs (id, task_id, mode, eval_id, status, started_at, updated_at, budget_usd, roles_json)
           VALUES ('r2', 't', 'eval', 'no-such-eval', 'success', 'x', 'x', 1, '{}')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
    old.close();
  });

  it("migration 004 backfills cycle counters only where the history is unambiguous", () => {
    const old = new Database(":memory:");
    old.pragma("foreign_keys = ON");
    const all = loadMigrations();
    migrate(
      old,
      all.filter((m) => m.version <= 3),
    );
    const insertRun = old.prepare(
      `INSERT INTO runs (id, task_id, mode, status, spec_approval, started_at, updated_at, budget_usd,
         roles_json, fix_cycles)
       VALUES (@id, 't', 'eval', 'success', @spec, 'x', 'x', 1, '{}', @fix)`,
    );
    const transition = old.prepare(
      "INSERT INTO events (run_id, ts, kind, node, next) VALUES (?, 'x', 'transition', ?, ?)",
    );
    const step = old.prepare(
      "INSERT INTO steps (run_id, node, cycle, attempt, status, started_at) VALUES (?, ?, ?, 1, 'ok', 'x')",
    );
    // Logged history: one gate fix and one review fix, consistent with fix_cycles.
    insertRun.run({ id: "logged", spec: "auto", fix: 2 });
    transition.run("logged", "gate", "develop");
    transition.run("logged", "review", "develop");
    transition.run("logged", "gate", "review");
    // Logged history that disagrees with fix_cycles: left NULL, not guessed.
    insertRun.run({ id: "inconsistent", spec: "auto", fix: 1 });
    transition.run("inconsistent", "review", "develop");
    transition.run("inconsistent", "review", "develop");
    // Week 1 import (no transitions): no fix cycle at all → 0/0.
    insertRun.run({ id: "w1-clean", spec: null, fix: 0 });
    step.run("w1-clean", "developer", 0);
    // Week 1 import with a fix cycle: the cause is unknown → NULL.
    insertRun.run({ id: "w1-fixed", spec: null, fix: 1 });
    step.run("w1-fixed", "developer", 0);
    step.run("w1-fixed", "developer", 1);
    old
      .prepare(
        `INSERT INTO approvals (run_id, gate, decision, actor, decided_at)
         VALUES ('logged', 'spec', 'reject', 'alice', 'x'), ('logged', 'spec', 'approve', 'alice', 'x')`,
      )
      .run();

    expect(migrate(old)).toEqual([4, 5, 6]);
    const s = new Store(old);
    const pick = (id: string) => {
      const r = s.requireRun(id);
      return [r.gate_fix_cycles, r.review_cycles, r.spec_revisions, r.first_pass, r.fix_cycles];
    };
    expect(pick("logged")).toEqual([1, 1, 1, null, 2]);
    expect(pick("inconsistent")).toEqual([null, null, 0, null, 1]);
    expect(pick("w1-clean")).toEqual([0, 0, null, null, 0]);
    expect(pick("w1-fixed")).toEqual([null, null, null, null, 1]);

    // New runs start with explicit counters; first_pass stays NULL until an eval decides it.
    const fresh = s.createRun({
      id: "new",
      projectId: "p",
      taskId: "t",
      mode: "eval",
      budgetUsd: 1,
      roles: ROLES,
      specApproval: "auto",
    });
    expect([
      fresh.gate_fix_cycles,
      fresh.review_cycles,
      fresh.spec_revisions,
      fresh.first_pass,
    ]).toEqual([0, 0, 0, null]);
    expect(s.updateRun("new", { firstPass: true, reviewCycles: 1 })).toMatchObject({
      first_pass: true,
      review_cycles: 1,
    });
    expect(s.updateRun("new", { firstPass: false }).first_pass).toBe(false);
    old.close();
  });

  const REAL_DB = path.join(FACTORY_ROOT, "data", "factory.db");
  it.skipIf(!existsSync(REAL_DB))(
    "migration 004 on a copy of the real database keeps every run readable",
    async () => {
      const source = new Database(REAL_DB, { readonly: true, fileMustExist: true });
      const copyPath = path.join(dir, "real-copy.db");
      await source.backup(copyPath);
      source.close();
      const copy = new Database(copyPath);
      const count = (sql: string) => (copy.prepare(sql).get() as { n: number }).n;
      const before = {
        runs: count("SELECT count(*) AS n FROM runs"),
        steps: count("SELECT count(*) AS n FROM steps"),
        events: count("SELECT count(*) AS n FROM events"),
        approvals: count("SELECT count(*) AS n FROM approvals"),
        evals: count("SELECT count(*) AS n FROM evals"),
      };
      const fixBefore = copy.prepare("SELECT id, status, fix_cycles FROM runs ORDER BY id").all();
      migrate(copy);
      expect({
        runs: count("SELECT count(*) AS n FROM runs"),
        steps: count("SELECT count(*) AS n FROM steps"),
        events: count("SELECT count(*) AS n FROM events"),
        approvals: count("SELECT count(*) AS n FROM approvals"),
        evals: count("SELECT count(*) AS n FROM evals"),
      }).toEqual(before);
      expect(copy.prepare("SELECT id, status, fix_cycles FROM runs ORDER BY id").all()).toEqual(
        fixBefore,
      );
      const s = new Store(copy);
      const rows = s.listRuns({ limit: 100_000 });
      expect(rows).toHaveLength(before.runs);
      // The real database may already be migrated (openDb applies migrations); runs recorded
      // before 004 must never get an invented first_pass.
      const applied = copy
        .prepare("SELECT applied_at FROM schema_migrations WHERE version = 4")
        .pluck()
        .get() as string;
      for (const r of rows) {
        if (r.started_at < applied) expect(r.first_pass).toBeNull();
        if (r.gate_fix_cycles !== null && r.review_cycles !== null) {
          expect(r.gate_fix_cycles + r.review_cycles).toBe(r.fix_cycles);
        }
      }
      copy.close();
    },
  );

  it("a foreign-keys-off migration that leaves dangling references is rolled back", () => {
    const fresh = new Database(":memory:");
    fresh.pragma("foreign_keys = ON");
    const all = loadMigrations();
    migrate(fresh, all);
    fresh
      .prepare(
        `INSERT INTO runs (id, task_id, mode, status, started_at, updated_at, budget_usd, roles_json)
         VALUES ('r', 't', 'eval', 'success', 'x', 'x', 1, '{}')`,
      )
      .run();
    const bad = {
      version: all.length + 1,
      name: "bad",
      checksum: "x",
      sql: "-- factory:foreign_keys=off\nINSERT INTO steps (run_id, node, attempt, status, started_at) VALUES ('missing', 'plan', 1, 'ok', 'x');",
    };
    expect(() => migrate(fresh, [...all, bad])).toThrow(/broke foreign keys/);
    expect(fresh.prepare("SELECT count(*) AS n FROM steps").get()).toEqual({ n: 0 });
    expect(fresh.pragma("foreign_keys", { simple: true })).toBe(1);
    fresh.close();
  });

  it("enforces foreign keys", () => {
    expect(() => store.startStep("no-such-run", "plan")).toThrow();
  });
});

describe("runs", () => {
  it("creates, reads, lists and updates a run; status changes are logged as events", () => {
    const run = newRun();
    expect(run).toMatchObject({ id: "run-1", status: "running", roles_json: ROLES, cost_usd: 0 });

    const updated = store.updateRun("run-1", {
      status: "awaiting_spec_approval",
      statusMessage: "spec ready",
      costUsd: 0.25,
      fixCycles: 1,
      worktreePath: "/w/run-1",
    });
    expect(updated).toMatchObject({
      status: "awaiting_spec_approval",
      status_message: "spec ready",
      cost_usd: 0.25,
      fix_cycles: 1,
      worktree_path: "/w/run-1",
    });
    expect(store.listRuns({ status: "awaiting_spec_approval" }).map((r) => r.id)).toEqual([
      "run-1",
    ]);
    expect(store.listEvents("run-1").map((e) => [e.kind, e.payload])).toEqual([
      ["status", JSON.stringify({ status: "awaiting_spec_approval", message: "spec ready" })],
    ]);
  });

  it("rejects unknown runs and invalid statuses", () => {
    expect(() => store.updateRun("missing", { costUsd: 1 })).toThrow(/not found/);
    newRun();
    expect(() => db.prepare("UPDATE runs SET mode = 'weird' WHERE id = 'run-1'").run()).toThrow();
  });

  it("locks a run to one live process and takes over a dead lock", () => {
    newRun();
    store.acquireLock("run-1", `${os.hostname()}:${process.pid}`);
    expect(() => {
      store.acquireLock("run-1", `${os.hostname()}:999999`);
    }).toThrow(RunLockedError);
    store.releaseLock("run-1", `${os.hostname()}:${process.pid}`);
    expect(store.requireRun("run-1").locked_by).toBeNull();

    // A lock left by a process that no longer exists is taken over.
    db.prepare("UPDATE runs SET locked_by = ? WHERE id = 'run-1'").run(`${os.hostname()}:999999`);
    store.acquireLock("run-1");
    expect(store.requireRun("run-1").locked_by).toBe(`${os.hostname()}:${process.pid}`);
  });
});

describe("steps", () => {
  it("numbers attempts per node and cycle, and abandons steps left running by a crash", () => {
    newRun();
    const first = store.startStep("run-1", "develop", 0, { runtime: "claude-code", model: "opus" });
    expect(first).toMatchObject({ attempt: 1, status: "running" });

    // The process "crashes": the step stays running. On resume it is abandoned and replayed.
    expect(store.abandonRunningSteps("run-1")).toBe(1);
    const replay = store.startStep("run-1", "develop", 0);
    expect(replay.attempt).toBe(2);
    const done = store.finishStep(replay.id, {
      status: "ok",
      costUsd: 0.17,
      logPath: "logs/02-developer.jsonl",
    });
    expect(done).toMatchObject({ status: "ok", cost_usd: 0.17 });
    expect(done.duration_ms).toBeGreaterThan(0);

    expect(store.startStep("run-1", "develop", 1).attempt).toBe(1); // new cycle starts at 1
    expect(store.listSteps("run-1").map((s) => [s.node, s.cycle, s.attempt, s.status])).toEqual([
      ["develop", 0, 1, "abandoned"],
      ["develop", 0, 2, "ok"],
      ["develop", 1, 1, "running"],
    ]);
    expect(store.listEvents("run-1").map((e) => e.kind)).toEqual([
      "node_start",
      "node_start",
      "node_end",
      "node_start",
    ]);
  });
});

describe("approvals, baselines, evals", () => {
  it("records approvals in order", () => {
    newRun();
    store.recordApproval({
      runId: "run-1",
      gate: "spec",
      decision: "reject",
      actor: "alex",
      comment: "split it",
    });
    store.recordApproval({ runId: "run-1", gate: "spec", decision: "approve", actor: "auto" });
    expect(
      store.listApprovals("run-1").map((a) => [a.gate, a.decision, a.actor, a.comment]),
    ).toEqual([
      ["spec", "reject", "alex", "split it"],
      ["spec", "approve", "auto", null],
    ]);
  });

  it("keeps a history of baselines and returns the latest", () => {
    expect(store.latestBaseline("taskflow")).toBeNull();
    store.recordBaseline({
      target: "taskflow",
      tag: "factory-baseline",
      commitHash: "aaa",
      actor: "factory",
    });
    store.recordBaseline({
      target: "taskflow",
      tag: "factory-baseline",
      commitHash: "bbb",
      previousHash: "aaa",
      actor: "alex",
      reason: "new fixture",
    });
    expect(store.latestBaseline("taskflow")).toMatchObject({
      commit_hash: "bbb",
      previous_hash: "aaa",
    });
  });

  it("tracks eval runs with their baseline commit", () => {
    store.createEval({
      id: "eval-1",
      repeatCount: 3,
      baselineCommit: "aaa",
      costCapUsd: 25,
      projectId: "p",
    });
    store.createRun({
      id: "run-e1",
      projectId: "p",
      taskId: "t",
      mode: "eval",
      budgetUsd: 1,
      roles: ROLES,
      evalId: "eval-1",
      evalRepeat: 1,
      specApproval: "auto",
      baselineCommit: "aaa",
    });
    expect(store.listRuns({ evalId: "eval-1" })[0]).toMatchObject({
      spec_approval: "auto",
      eval_repeat: 1,
    });
    expect(
      store.finishEval("eval-1", {
        status: "cost_cap_reached",
        costUsd: 25.4,
        summaryPath: "s.md",
      }),
    ).toMatchObject({
      status: "cost_cap_reached",
      baseline_commit: "aaa",
    });
  });
});

describe("secret masking", () => {
  it("never stores a secret in events, statuses, step errors or approvals", () => {
    newRun();
    store.appendEvent("run-1", {
      kind: "transition",
      node: "review",
      next: "report",
      payload: { env: { KEY: SECRET } },
    });
    store.updateRun("run-1", { status: "error", statusMessage: `provider rejected key ${SECRET}` });
    const step = store.startStep("run-1", "review");
    store.finishStep(step.id, {
      status: "failed",
      error: { kind: "process", message: `401 for ${SECRET}` },
    });
    store.recordApproval({
      runId: "run-1",
      gate: "merge",
      decision: "close",
      actor: "alex",
      comment: SECRET,
    });

    db.pragma("wal_checkpoint(TRUNCATE)");
    const raw = readFileSync(path.join(dir, "factory.db"));
    expect(raw.includes(Buffer.from(SECRET))).toBe(false);
    expect(store.requireRun("run-1").status_message).toBe(`provider rejected key ${MASK}`);
  });

  it("redactor masks longer secrets first and ignores short values", () => {
    const r = createRedactor(["abcdefgh", "abcdefgh-ijkl", "short", undefined]);
    expect(r("x abcdefgh-ijkl y abcdefgh z short")).toBe(`x ${MASK} y ${MASK} z short`);
    expect(secretsFromEnv(["A", "B", "C"], { A: "value-a-123", B: "" })).toEqual(["value-a-123"]);
  });
});
