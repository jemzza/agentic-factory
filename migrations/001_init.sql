-- 001: runs, steps, events, approvals, baselines, evals.
-- Times are ISO-8601 UTC strings. JSON columns hold Zod-validated JSON text.

CREATE TABLE baselines (
  id            INTEGER PRIMARY KEY,
  target        TEXT NOT NULL,
  tag           TEXT NOT NULL,                -- e.g. factory-baseline
  commit_hash   TEXT NOT NULL,
  previous_hash TEXT,                         -- commit the tag pointed to before (NULL on creation)
  actor         TEXT NOT NULL,
  reason        TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX baselines_target ON baselines(target, id);

CREATE TABLE evals (
  id              TEXT PRIMARY KEY,           -- eval-<timestamp>
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  status          TEXT NOT NULL CHECK (status IN ('running','completed','cost_cap_reached','error')),
  repeat_count    INTEGER NOT NULL DEFAULT 1,
  baseline_commit TEXT NOT NULL,
  cost_cap_usd    REAL,
  cost_usd        REAL NOT NULL DEFAULT 0,
  summary_path    TEXT
);

CREATE TABLE runs (
  id                 TEXT PRIMARY KEY,        -- runId = LangGraph thread_id
  task_id            TEXT NOT NULL,
  mode               TEXT NOT NULL CHECK (mode IN ('interactive','eval')),
  eval_id            TEXT REFERENCES evals(id),
  eval_repeat        INTEGER,
  status             TEXT NOT NULL,
  status_message     TEXT NOT NULL DEFAULT '',
  spec_approval      TEXT CHECK (spec_approval IN ('manual','auto')),
  started_at         TEXT NOT NULL,
  finished_at        TEXT,
  updated_at         TEXT NOT NULL,
  cost_usd           REAL NOT NULL DEFAULT 0,
  budget_usd         REAL NOT NULL,
  unknown_cost_steps INTEGER NOT NULL DEFAULT 0,
  fix_cycles         INTEGER NOT NULL DEFAULT 0,
  roles_json         TEXT NOT NULL,           -- {"planner":{"runtime","model"},...}
  baseline_commit    TEXT,
  worktree_path      TEXT,
  branch             TEXT,
  base_commit        TEXT,
  head_commit        TEXT,
  report_path        TEXT,
  locked_by          TEXT                     -- "<host>:<pid>" while a process drives the run
);
CREATE INDEX runs_task ON runs(task_id);
CREATE INDEX runs_status ON runs(status);
CREATE INDEX runs_eval ON runs(eval_id);

CREATE TABLE steps (
  id            INTEGER PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs(id),
  node          TEXT NOT NULL,
  cycle         INTEGER NOT NULL DEFAULT 0,
  attempt       INTEGER NOT NULL,             -- 2+ when the node was replayed after a crash
  status        TEXT NOT NULL CHECK (status IN ('running','ok','failed','abandoned','interrupted')),
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  duration_ms   INTEGER,
  cost_usd      REAL,
  runtime       TEXT,
  model         TEXT,
  log_path      TEXT,
  error_kind    TEXT,
  error_message TEXT,
  UNIQUE (run_id, node, cycle, attempt)
);
CREATE INDEX steps_run ON steps(run_id, id);

CREATE TABLE events (
  id       INTEGER PRIMARY KEY,
  run_id   TEXT NOT NULL REFERENCES runs(id),
  ts       TEXT NOT NULL,
  kind     TEXT NOT NULL CHECK (kind IN ('node_start','node_end','transition','interrupt','resume','status')),
  node     TEXT,
  next     TEXT,
  payload  TEXT                               -- JSON; secrets are masked before writing
);
CREATE INDEX events_run ON events(run_id, id);

CREATE TABLE approvals (
  id          INTEGER PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id),
  gate        TEXT NOT NULL CHECK (gate IN ('spec','merge')),
  decision    TEXT NOT NULL CHECK (decision IN ('approve','reject','merge','close')),
  actor       TEXT NOT NULL,                  -- OS user for manual decisions, 'auto' for --auto-approve-spec
  comment     TEXT,
  decided_at  TEXT NOT NULL
);
CREATE INDEX approvals_run ON approvals(run_id, id);
