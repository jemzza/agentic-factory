> Copied from `runs/eval-20261016-165136/r1/summary.md` (run artifacts are git-ignored). Week 2, Opus reviewer, part 2 of 2: the 4 tasks re-run after the limit reset, same configuration.

# Eval eval-20261016-165136/r1

- **Started:** 2026-10-16T16:51:36.806Z **Finished:** 2026-10-16T17:00:13.819Z
- **Runtime / models:** claude-code — planner: claude-code:opus, developer: claude-code:opus, reviewer: claude-code:opus
- **Spec approval:** auto (eval runs are unattended; manual approvals are not mixed into these metrics)

## Metrics

| Metric                                                    | Value            |
| --------------------------------------------------------- | ---------------- |
| Verified rate (correct / total)                           | **100.0%** (4/4) |
| False success rate (claimed success, hidden tests failed) | **0.0%** (0/4)   |
| Average fix cycles (tasks that reached the developer)     | 0.00             |
| Average time per task                                     | 128.5s           |
| Total cost                                                | $2.629           |
| Hidden-test files found in agent worktrees                | 0                |
| Outcomes                                                  | verified: 4      |

## Tasks

| Task             | Difficulty | Expected    | Run status | Outcome      | Correct | Hidden tests | Fix cycles | Time | Cost   | Report                |
| ---------------- | ---------- | ----------- | ---------- | ------------ | ------- | ------------ | ---------- | ---- | ------ | --------------------- |
| `restore-task`   | medium     | implemented | success    | **verified** | ✅      | 6/6          | 0          | 107s | $0.664 | report (not included) |
| `search-tasks`   | simple     | implemented | success    | **verified** | ✅      | 8/8          | 0          | 137s | $0.639 | report (not included) |
| `sort-tasks`     | medium     | implemented | success    | **verified** | ✅      | 10/10        | 0          | 127s | $0.628 | report (not included) |
| `status-history` | hard       | implemented | success    | **verified** | ✅      | 9/9          | 0          | 142s | $0.698 | report (not included) |

## Definitions

- **verified**: the run ended in `success` _and_ the hidden acceptance tests (never shown to the agent) passed on a copy of the final worktree.
- **false_success**: the run ended in `success` but the hidden tests failed — the system claimed success wrongly.
- **needs_clarification** is the correct outcome for tasks whose request is contradictory; it counts as correct only there.
- Any other outcome is the pipeline's final status (`gate_failed`, `review_rejected`, `timeout`, `budget_exceeded`, `error`).
- Costs are list-price estimates reported by the agent CLI.
