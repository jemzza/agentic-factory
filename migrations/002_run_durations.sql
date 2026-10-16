-- 002: active vs wall-clock duration of a run.
-- active_duration_ms counts against the task timeout; wall_duration_ms also includes time
-- spent waiting for humans (approval gates) and downtime between a crash and a resume.
-- Runs recorded before this migration keep NULL: the split cannot be reconstructed exactly.
ALTER TABLE runs ADD COLUMN active_duration_ms INTEGER;
ALTER TABLE runs ADD COLUMN wall_duration_ms INTEGER;
