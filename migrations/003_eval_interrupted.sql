-- factory:foreign_keys=off
-- 003: an eval can be `interrupted` — stopped because the model provider was unavailable
-- (usage/rate limit, outage). It is resumed with `npm run eval -- --resume <evalId>`.
-- SQLite cannot change a CHECK constraint in place, so the table is rebuilt following
-- https://www.sqlite.org/lang_altertable.html#otheralter: the runner turns foreign keys off
-- for this migration (first line), runs `PRAGMA foreign_key_check` before COMMIT and turns
-- them back on. `runs.eval_id REFERENCES evals(id)` keeps pointing at the new table.
CREATE TABLE evals_new (
  id              TEXT PRIMARY KEY,           -- eval-<timestamp>
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  status          TEXT NOT NULL CHECK (status IN ('running','completed','cost_cap_reached','error','interrupted')),
  repeat_count    INTEGER NOT NULL DEFAULT 1,
  baseline_commit TEXT NOT NULL,
  cost_cap_usd    REAL,
  cost_usd        REAL NOT NULL DEFAULT 0,
  summary_path    TEXT
);
INSERT INTO evals_new SELECT id, started_at, finished_at, status, repeat_count, baseline_commit,
  cost_cap_usd, cost_usd, summary_path FROM evals;
DROP TABLE evals;
ALTER TABLE evals_new RENAME TO evals;
