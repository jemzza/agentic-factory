-- Week 3 Phase 3: GitHub as the main interface.
-- github_events: every issue and comment the watcher has decided about, exactly once
--   (UNIQUE). `applied` = the decision's effect on the run (resume with an approval) is done;
--   a restart re-applies executed-but-unapplied events and never executes a command twice.
-- spec_versions: every specification published as an issue comment, with its hash; an
--   /approve counts only for the latest version and only if written after it was published.
-- gh_cursors: polling position per project and stream (`since`).
-- locks: process-wide named locks (the single factory:watch instance).
CREATE TABLE github_events (
  id           INTEGER PRIMARY KEY,
  project_id   TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('issue', 'comment', 'pr')),
  github_id    INTEGER NOT NULL,
  number       INTEGER,
  author       TEXT,
  outcome      TEXT NOT NULL CHECK (outcome IN ('accepted', 'executed', 'invalid',
                 'ignored_unauthorized', 'ignored_stale', 'ignored_not_applicable',
                 'not_command', 'factory_comment')),
  run_id       TEXT REFERENCES runs(id),
  detail       TEXT,
  applied      INTEGER NOT NULL DEFAULT 0 CHECK (applied IN (0, 1)),
  processed_at TEXT NOT NULL,
  UNIQUE (project_id, kind, github_id)
);
CREATE INDEX github_events_unapplied ON github_events(project_id, applied, outcome);

CREATE TABLE spec_versions (
  run_id       TEXT NOT NULL REFERENCES runs(id),
  version      INTEGER NOT NULL,
  hash         TEXT NOT NULL,
  spec_commit  TEXT NOT NULL,                -- each draft is a new version, even if identical
  comment_id   INTEGER,
  published_at TEXT NOT NULL,
  PRIMARY KEY (run_id, version)
);

CREATE TABLE gh_cursors (
  project_id TEXT NOT NULL,
  stream     TEXT NOT NULL,
  since      TEXT NOT NULL,
  PRIMARY KEY (project_id, stream)
);

CREATE TABLE locks (
  name        TEXT PRIMARY KEY,
  holder      TEXT NOT NULL,
  acquired_at TEXT NOT NULL
);

-- Where a decision came from. Week 1–2 decisions were the CLI or --auto-approve-spec.
ALTER TABLE approvals ADD COLUMN channel TEXT NOT NULL DEFAULT 'cli'
  CHECK (channel IN ('cli', 'github', 'auto'));
UPDATE approvals SET channel = 'auto' WHERE actor = 'auto';

ALTER TABLE runs ADD COLUMN issue_number INTEGER;
ALTER TABLE runs ADD COLUMN pr_number INTEGER;
CREATE INDEX runs_issue ON runs(project_id, issue_number);
