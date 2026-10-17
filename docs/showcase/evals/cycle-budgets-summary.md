> Copied from `runs/eval-20261017-095351/summary.md` (run artifacts are git-ignored). Cycle-budget correction: 10 tasks × 3 repeats, all roles Opus, with first-pass rate. Analysis: [docs/cycles-budget-results.md](../../cycles-budget-results.md).

# Eval eval-20261017-095351 — 3/3 repeat(s)

- **Roles:** planner = claude-code:opus; developer = claude-code:opus; reviewer = claude-code:opus
- **Spec approval:** auto · **Baseline commit:** `c3ec3cd53d55fd974db3b8565e2410e1c88a01d2`
- **Cost cap:** $28
- **Factory commit per repeat:** r1 `bb50b61be901`, r2 `bb50b61be901`, r3 `bb50b61be901`

## Metrics (mean ± sample stdev across repeats)

| Metric                                                      | Value                                            |
| ----------------------------------------------------------- | ------------------------------------------------ |
| First-pass rate (verified, no rework / implementable tasks) | **96.3%** ± 6.4% (min 88.9%, max 100.0%, n=3)    |
| Verified rate                                               | **96.7%** ± 5.8% (min 90.0%, max 100.0%, n=3)    |
| False success rate                                          | **0.0%** ± 0.0% (min 0.0%, max 0.0%, n=3)        |
| Average gate fix cycles                                     | **0.00** ± 0.00 (min 0.00, max 0.00, n=3)        |
| Average review cycles                                       | **0.00** ± 0.00 (min 0.00, max 0.00, n=3)        |
| Average fix cycles, total                                   | **0.00** ± 0.00 (min 0.00, max 0.00, n=3)        |
| Stopped by the review limit (review_rejected / reviewed)    | **0.0%** ± 0.0% (min 0.0%, max 0.0%, n=3)        |
| Excluded: provider unavailable (infra_error), all repeats   | 0 task attempt(s)                                |
| Average time per task                                       | **156.7s** ± 27.4s (min 126.3s, max 179.4s, n=3) |
| Cost per repeat                                             | **$5.98** ± $0.38 (min $5.57, max $6.33, n=3)    |

## Outcomes per task (✗ = not the correct outcome)

| Task             | r1                  | r2                  | r3                  |
| ---------------- | ------------------- | ------------------- | ------------------- |
| `bulk-status`    | verified            | verified            | verified            |
| `complete-task`  | verified            | verified            | verified            |
| `due-date`       | verified            | timeout✗            | verified            |
| `hard-delete`    | needs_clarification | needs_clarification | needs_clarification |
| `pagination`     | verified            | verified            | verified            |
| `reopen-task`    | verified            | verified            | verified            |
| `restore-task`   | verified            | verified            | verified            |
| `search-tasks`   | verified            | verified            | verified            |
| `sort-tasks`     | verified            | verified            | verified            |
| `status-history` | verified            | verified            | verified            |

Per-repeat details: `r<N>/summary.md`.
