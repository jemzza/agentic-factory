-- Week 3 Phase 1: rescored evals (`npm run eval:rescore`). A rescore re-runs only the hidden
-- tests on the stored final diffs of another eval; it never calls an agent and costs $0.
-- Existing rows are ordinary eval runs.
ALTER TABLE evals ADD COLUMN kind TEXT NOT NULL DEFAULT 'run' CHECK (kind IN ('run', 'rescore'));
ALTER TABLE evals ADD COLUMN source_eval_id TEXT REFERENCES evals(id);
