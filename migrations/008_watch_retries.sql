-- Week 3 Phase 4: factory:watch continues on its own after infra_error. A task whose run ended
-- infra_error (provider or host unavailable) is retried automatically once the pause is over;
-- the intent is persisted so a restart keeps it.
CREATE TABLE watch_retries (
  run_id       TEXT PRIMARY KEY REFERENCES runs(id),
  project_id   TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  not_before   TEXT NOT NULL
);
