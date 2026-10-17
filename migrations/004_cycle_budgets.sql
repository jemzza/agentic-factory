-- 004: separate cycle budgets, first-pass flag, spec revisions.
-- gate_fix_cycles / review_cycles: developer re-runs after a failed quality gate / after reviewer
--   request_changes (fix_cycles stays their sum, for older readers).
-- first_pass: 1/0 once an eval decided it (verified with no fix cycles); NULL otherwise.
-- spec_revisions: times a human rejected the specification.
-- The columns have no DEFAULT on purpose: rows recorded before this migration stay NULL unless
-- the backfill below reconstructs the value unambiguously. New runs get explicit values.
-- `infra_error` needs no change here: runs.status has no CHECK constraint and the application
-- enum (STORED_RUN_STATUSES) already contains it.
ALTER TABLE runs ADD COLUMN gate_fix_cycles INTEGER;
ALTER TABLE runs ADD COLUMN review_cycles INTEGER;
ALTER TABLE runs ADD COLUMN first_pass INTEGER CHECK (first_pass IN (0, 1));
ALTER TABLE runs ADD COLUMN spec_revisions INTEGER;

-- Backfill 1: runs with a transition log. Every fix cycle is one `gate → develop` or
-- `review → develop` transition. Accepted only when the two counts add up to fix_cycles.
UPDATE runs
SET gate_fix_cycles = t.gate_fix, review_cycles = t.review
FROM (
  SELECT run_id,
    SUM(node = 'gate' AND next = 'develop') AS gate_fix,
    SUM(node = 'review' AND next = 'develop') AS review
  FROM events WHERE kind = 'transition' GROUP BY run_id
) AS t
WHERE t.run_id = runs.id AND t.gate_fix + t.review = runs.fix_cycles;

-- Backfill 2: runs without a transition log (imported from Week 1 report.json files). Only the
-- unambiguous case: no fix cycle at all (fix_cycles = 0 and no developer step beyond cycle 0).
UPDATE runs
SET gate_fix_cycles = 0, review_cycles = 0
WHERE gate_fix_cycles IS NULL
  AND fix_cycles = 0
  AND NOT EXISTS (SELECT 1 FROM events e WHERE e.run_id = runs.id AND e.kind = 'transition')
  AND NOT EXISTS (
    SELECT 1 FROM steps s WHERE s.run_id = runs.id AND s.node = 'developer' AND s.cycle > 0
  );

-- Backfill 3: spec revisions, for runs that had a specification approval stage (Week 2+).
-- Week 1 runs (spec_approval IS NULL) had no such stage and stay NULL.
UPDATE runs
SET spec_revisions = (
  SELECT COUNT(*) FROM approvals a
  WHERE a.run_id = runs.id AND a.gate = 'spec' AND a.decision = 'reject'
)
WHERE spec_approval IS NOT NULL;

-- first_pass is not backfilled: it needs hidden-test results, which are not in the database.
