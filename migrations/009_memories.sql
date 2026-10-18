-- Week 3 Phase 5: project memory. The canonical copy of every memory record lives here; the
-- Mem0 vector index is derived from it and can be rebuilt (`npm run memory -- reindex`).
-- embed_model: the embedder (provider/model@digest) whose vectors the record has in the index.
CREATE TABLE memories (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  text        TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('spec_rejection_comment', 'review_issue_fixed',
                'merged_run', 'manual')),
  run_id      TEXT,
  created_at  TEXT NOT NULL,
  embed_model TEXT NOT NULL,
  index_id    TEXT,
  removed_at  TEXT,
  -- e.g. "<runId>:lesson:0": a node replayed after a crash never stores a record twice
  dedupe_key  TEXT UNIQUE
);
CREATE INDEX memories_project ON memories(project_id, removed_at);

-- One row per index: which embedder built it. A different embedder in the config is refused
-- until the index is rebuilt from `memories`.
CREATE TABLE memory_index (
  name        TEXT PRIMARY KEY,
  embed_model TEXT NOT NULL,
  dims        INTEGER NOT NULL,
  built_at    TEXT NOT NULL
);
