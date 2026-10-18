-- Week 3 Phase 2: one factory, many projects. Every run, event, approval, eval and baseline
-- belongs to a project (`projects.yaml`). Everything recorded before this migration was
-- TaskFlow, the only target until now. The DEFAULT only fills existing rows; the code always
-- writes project_id explicitly.
ALTER TABLE runs ADD COLUMN project_id TEXT NOT NULL DEFAULT 'taskflow';
ALTER TABLE events ADD COLUMN project_id TEXT NOT NULL DEFAULT 'taskflow';
ALTER TABLE approvals ADD COLUMN project_id TEXT NOT NULL DEFAULT 'taskflow';
ALTER TABLE evals ADD COLUMN project_id TEXT NOT NULL DEFAULT 'taskflow';
ALTER TABLE baselines ADD COLUMN project_id TEXT NOT NULL DEFAULT 'taskflow';
UPDATE baselines SET project_id = target;
CREATE INDEX runs_project_status ON runs(project_id, status);
