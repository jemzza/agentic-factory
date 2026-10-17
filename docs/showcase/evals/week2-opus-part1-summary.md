> Copied from `runs/eval-20261016-115810/r1/summary.md` (run artifacts are git-ignored). Week 2, Opus reviewer, part 1 of 2: tasks 1–6 count; tasks 7–10 hit the Claude subscription session limit (recorded as `error` before `infra_error` existed) and were re-run in part 2.

# Eval eval-20261016-115810/r1

- **Started:** 2026-10-16T11:58:10.208Z **Finished:** 2026-10-16T12:10:43.840Z
- **Runtime / models:** claude-code — planner: claude-code:opus, developer: claude-code:opus, reviewer: claude-code:opus
- **Spec approval:** auto (eval runs are unattended; manual approvals are not mixed into these metrics)

## Metrics

| Metric                                                    | Value                                         |
| --------------------------------------------------------- | --------------------------------------------- |
| Verified rate (correct / total)                           | **60.0%** (6/10)                              |
| False success rate (claimed success, hidden tests failed) | **0.0%** (0/5)                                |
| Average fix cycles (tasks that reached the developer)     | 0.00                                          |
| Average time per task                                     | 75.0s                                         |
| Total cost                                                | $3.517                                        |
| Hidden-test files found in agent worktrees                | 0                                             |
| Outcomes                                                  | verified: 5, needs_clarification: 1, error: 4 |

## Tasks

| Task             | Difficulty | Expected            | Run status          | Outcome                 | Correct | Hidden tests | Fix cycles | Time | Cost   | Report                |
| ---------------- | ---------- | ------------------- | ------------------- | ----------------------- | ------- | ------------ | ---------- | ---- | ------ | --------------------- |
| `bulk-status`    | medium     | implemented         | success             | **verified**            | ✅      | 11/11        | 0          | 127s | $0.588 | report (not included) |
| `complete-task`  | simple     | implemented         | success             | **verified**            | ✅      | 4/4          | 0          | 80s  | $0.365 | report (not included) |
| `due-date`       | medium     | implemented         | success             | **verified**            | ✅      | 20/20        | 0          | 193s | $0.951 | report (not included) |
| `hard-delete`    | simple     | needs_clarification | needs_clarification | **needs_clarification** | ✅      | —            | 0          | 15s  | $0.050 | report (not included) |
| `pagination`     | hard       | implemented         | success             | **verified**            | ✅      | 19/19        | 0          | 184s | $0.873 | report (not included) |
| `reopen-task`    | simple     | implemented         | success             | **verified**            | ✅      | 5/5          | 0          | 78s  | $0.366 | report (not included) |
| `restore-task`   | medium     | implemented         | error               | **error**               | ❌      | —            | 0          | 70s  | $0.324 | report (not included) |
| `search-tasks`   | simple     | implemented         | error               | **error**               | ❌      | —            | 0          | 1s   | $0.000 | report (not included) |
| `sort-tasks`     | medium     | implemented         | error               | **error**               | ❌      | —            | 0          | 1s   | $0.000 | report (not included) |
| `status-history` | hard       | implemented         | error               | **error**               | ❌      | —            | 0          | 1s   | $0.000 | report (not included) |

## Definitions

- **verified**: the run ended in `success` _and_ the hidden acceptance tests (never shown to the agent) passed on a copy of the final worktree.
- **false_success**: the run ended in `success` but the hidden tests failed — the system claimed success wrongly.
- **needs_clarification** is the correct outcome for tasks whose request is contradictory; it counts as correct only there.
- Any other outcome is the pipeline's final status (`gate_failed`, `review_rejected`, `timeout`, `budget_exceeded`, `error`).
- Costs are list-price estimates reported by the agent CLI.

## Details for incorrect outcomes

### `restore-task` — error

process error in developer: agent run failed (success): You've hit your session limit · resets 7:10pm (Europe/Moscow)

### `search-tasks` — error

process error in planner: agent run failed (success): You've hit your session limit · resets 7:10pm (Europe/Moscow)

### `sort-tasks` — error

process error in planner: agent run failed (success): You've hit your session limit · resets 7:10pm (Europe/Moscow)

### `status-history` — error

process error in planner: agent run failed (success): You've hit your session limit · resets 7:10pm (Europe/Moscow)
