> Copied from `runs/eval-20261016-113113/r1/summary.md` (run artifacts are git-ignored). Week 2, Sol reviewer (OpenCode `openai/gpt-6.1-sol`), the complete first repeat. A second repeat stopped at 4/10 when the OpenAI budget ran out.

# Eval eval-20261016-113113/r1

- **Started:** 2026-10-16T11:31:13.497Z **Finished:** 2026-10-16T11:57:43.523Z
- **Runtime / models:** claude-code+opencode — planner: claude-code:opus, developer: claude-code:opus, reviewer: opencode:openai/gpt-6.1-sol
- **Spec approval:** auto (eval runs are unattended; manual approvals are not mixed into these metrics)

## Metrics

| Metric                                                    | Value                                                   |
| --------------------------------------------------------- | ------------------------------------------------------- |
| Verified rate (correct / total)                           | **90.0%** (9/10)                                        |
| False success rate (claimed success, hidden tests failed) | **0.0%** (0/8)                                          |
| Average fix cycles (tasks that reached the developer)     | 0.44                                                    |
| Average time per task                                     | 158.3s                                                  |
| Total cost                                                | $6.026                                                  |
| Hidden-test files found in agent worktrees                | 0                                                       |
| Outcomes                                                  | review_rejected: 1, verified: 8, needs_clarification: 1 |

## Tasks

| Task             | Difficulty | Expected            | Run status          | Outcome                 | Correct | Hidden tests | Fix cycles | Time | Cost   | Report                |
| ---------------- | ---------- | ------------------- | ------------------- | ----------------------- | ------- | ------------ | ---------- | ---- | ------ | --------------------- |
| `bulk-status`    | medium     | implemented         | review_rejected     | **review_rejected**     | ❌      | —            | 2          | 342s | $1.195 | report (not included) |
| `complete-task`  | simple     | implemented         | success             | **verified**            | ✅      | 4/4          | 1          | 124s | $0.460 | report (not included) |
| `due-date`       | medium     | implemented         | success             | **verified**            | ✅      | 20/20        | 0          | 195s | $0.797 | report (not included) |
| `hard-delete`    | simple     | needs_clarification | needs_clarification | **needs_clarification** | ✅      | —            | 0          | 20s  | $0.054 | report (not included) |
| `pagination`     | hard       | implemented         | success             | **verified**            | ✅      | 19/19        | 0          | 185s | $0.788 | report (not included) |
| `reopen-task`    | simple     | implemented         | success             | **verified**            | ✅      | 5/5          | 1          | 147s | $0.516 | report (not included) |
| `restore-task`   | medium     | implemented         | success             | **verified**            | ✅      | 6/6          | 0          | 126s | $0.444 | report (not included) |
| `search-tasks`   | simple     | implemented         | success             | **verified**            | ✅      | 8/8          | 0          | 133s | $0.566 | report (not included) |
| `sort-tasks`     | medium     | implemented         | success             | **verified**            | ✅      | 10/10        | 0          | 138s | $0.541 | report (not included) |
| `status-history` | hard       | implemented         | success             | **verified**            | ✅      | 9/9          | 0          | 172s | $0.666 | report (not included) |

## Definitions

- **verified**: the run ended in `success` _and_ the hidden acceptance tests (never shown to the agent) passed on a copy of the final worktree.
- **false_success**: the run ended in `success` but the hidden tests failed — the system claimed success wrongly.
- **needs_clarification** is the correct outcome for tasks whose request is contradictory; it counts as correct only there.
- Any other outcome is the pipeline's final status (`gate_failed`, `review_rejected`, `timeout`, `budget_exceeded`, `error`).
- Costs are list-price estimates reported by the agent CLI.

## Details for incorrect outcomes

### `bulk-status` — review_rejected

reviewer did not approve after 2 fix cycle(s)
