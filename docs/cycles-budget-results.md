# Cycle budgets and first-pass rate: results

Correction after the Week 2 architecture review, branch `fix/cycle-budgets`:

- separate budgets for fix cycles after a failed quality gate (`max_gate_fix_cycles`, default 2)
  and after reviewer `request_changes` (`max_review_cycles`, default 1). Before this change both
  shared one counter (`max_fix_cycles: 2`);
- a **first-pass rate** metric;
- provider limits recorded as `infra_error`, kept out of quality metrics.

## Measurement

|                |                                                                                                                                                                                                                                                           |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Eval           | `eval-20261017-095351`: `npm run eval -- --repeat 1 --cost-cap 28`, then, after the r1 cost check, `npm run eval -- --resume eval-20261017-095351 --repeat 3 --cost-cap 28` (twice, the second time after the limit reset). Repeats ran one after another |
| Factory commit | `bb50b61` for all three repeats (no code change between the start and the resumes)                                                                                                                                                                        |
| Roles          | planner, developer and reviewer: Claude Code `opus` (Opus 5.5). The OpenCode reviewer is disabled                                                                                                                                                         |
| Target         | TaskFlow, 10 tasks, starting from `factory-baseline` = `c3ec3cd`, specs approved automatically                                                                                                                                                            |
| Interruptions  | Repeat 3 stopped at `sort-tasks` with `infra_error` ("You've hit your session limit"). After the limit reset it was continued with `--resume`. The 8 tasks already decided were kept, and only `sort-tasks` and `status-history` were run                 |
| Cost           | $17.93 in total: $6.03 + $5.57 + $6.09 for the repeats, plus $0.24 for the attempt the limit interrupted. The estimate was about $18                                                                                                                      |

## Metrics

Mean ± sample standard deviation over 3 repeats. The Week 2 column is a **single run** with the
Opus reviewer, recomputed with the new metric definitions from its `summary.json` files.

| Metric                                  | After the change (3 repeats)                         | Week 2, Opus reviewer (1 run)¹                            |
| --------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------- |
| First-pass rate                         | **96.3% ± 6.4%** (9/9, 8/9, 9/9)                     | 100% (9/9)                                                |
| Verified rate                           | **96.7% ± 5.8%** (10/10, 9/10, 10/10)                | 100% (10/10)                                              |
| False success rate                      | **0% ± 0%** (0/9, 0/8, 0/9)                          | 0% (0/9)                                                  |
| Clarification task (`hard-delete`)      | correct answer in 3 of 3                             | correct answer in 1 of 1                                  |
| Avg gate fix cycles                     | 0.00 ± 0.00                                          | 0 (only the total was recorded)                           |
| Avg review cycles                       | 0.00 ± 0.00                                          | 0 (only the total was recorded)                           |
| Ended `gate_failed` / `review_rejected` | 0 / 0 in every repeat                                | 0 / 0                                                     |
| Stopped by the review limit             | 0% (0 of 27 tasks that reached review)               | —                                                         |
| Used the whole review budget            | 0 tasks                                              | —                                                         |
| `infra_error`                           | 1 attempt (`sort-tasks`, r3), replaced by the resume | 4 tasks recorded as `error`, before `infra_error` existed |
| Avg time per task                       | 156.7 s ± 27.4 s                                     | 119.1 s                                                   |
| Cost per repeat                         | $5.98 ± $0.38                                        | $5.82 (+ $0.32 lost)                                      |

¹ Week 2 is a **combined** measurement. Tasks 1–6 come from `eval-20261016-115810`. That run hit
the subscription session limit at task 7, and its last 4 tasks were recorded as `error`. Tasks
7–10 come from `eval-20261016-165136`, which re-ran those 4 tasks after the reset. The
first-pass figure is derived from `fixCycles = 0`, which is unambiguous because every task had
0 fix cycles.

### The only incorrect outcome: a provider outage that was recorded as `timeout`

In r2, `due-date` ended `timeout`: the reviewer step reached its 300 s step timeout. Its raw log
(`r2/20261017-102800-23d6/logs/03-reviewer-c0.jsonl`) contains only `system/init` and nine
`system/api_retry` events (`"error": "unknown"`, `error_status: null`, backoff up to 32.5 s),
and no model output at all. The API never answered, so this is a provider failure, not a
factory failure. The planner and developer of that run had succeeded, and the gate had passed.

The current patterns do not recognise this case: the step ended on the factory's timeout, not
on an API error result. It therefore counts as a quality outcome. It is the only reason r2 has
9/10 verified and 8/9 first-pass. With it removed, all three repeats would be 100%. These
metrics are reported **as the system computed them**; nothing here is adjusted by hand.
Classifying a timeout whose log has only `api_retry` events and no model output as
`infra_error` is a proposed follow-up. It needs a decision and is not part of this change.

### Other observations

- No task used a fix cycle of either kind in 30 task attempts: the gate passed every time, and
  every completed review approved the first version. The split budgets were not exercised by this
  measurement. Their behaviour is covered by the fake-runtime tests (Phase 2).
- `search-tasks` in r1 took 701 s, 643 s of it in the developer step. The step had no rework,
  no timeout and a normal cost ($0.40). One Bash command was denied by the tool policy and the
  developer continued with Read/Edit. The remaining time is not explained by the log; it looks
  like model or API latency.
- Mean step costs: planner $0.18, developer $0.32, reviewer $0.13. One more review cycle would
  cost about $0.45 per task (developer + gate + reviewer).

## How many tasks hit the review limit

**None.** 27 implementable tasks reached review (9 per repeat). 26 of the reviews returned
`approve` on the first try, and one was cut off by the provider outage described above, with no
verdict. No task got `request_changes`, so no task ended `review_rejected`, and none used its
single review cycle.

## Recommendation: keep `max_review_cycles: 1`

- **The measurement does not support raising it.** The limit never engaged: none of the 26 completed
  reviews asked for changes. Raising it to 2 would change none of the 30 outcomes measured here.
- **The cost of a higher limit is concrete, and its benefit is not.** Each extra review cycle
  costs about $0.45 per task. The only time review cycles were spent in this project was Week 2
  with the Sol reviewer: `bulk-status` used both shared cycles in both repeats and still ended
  `review_rejected`. The Opus run's first version of that task passed all 11 hidden tests. That
  is evidence that extra review cycles under over-strict review cost money without a verified
  gain. Note that it comes from a different reviewer configuration.
- **When to revisit:** after the reviewer-calibration correction, or when an independent
  reviewer is enabled again. Then re-run with the same metrics and look at "Used the whole
  review budget" and "Stopped by the review limit". If several tasks are rejected after one
  rework and the hidden tests show the rework was needed, raise the limit to 2.

## Comparison with Week 2: verified and false success

- False success is 0% in every repeat and in Week 2. The honesty metric did not get worse.
- Verified rate is 96.7% ± 5.8% against 100% in a single Week 2 run. The difference is one task in
  one repeat, within the spread, and explained above: a provider outage recorded as `timeout`.
  No task failed its hidden tests and no task was stopped by a cycle limit.
- The suite is saturated for Opus (as noted in Week 2): at 100% it can only show regressions, and
  with no fix cycles at all it cannot show whether the split budgets improve anything.

## Limitations

- **The reviewer is the same vendor and the same model as the developer** (Claude Code Opus 5.5).
  The architecture intends an independent reviewer from another vendor. With the same model, the
  review is less independent: it may share the developer's blind spots. The 0% rejection rate
  should be read with that in mind. The OpenCode reviewer stays implemented and tested, but
  it is disabled in `factory.config.ts` by the project owner's decision.
- Three repeats of 10 tasks. The spread is estimated from n = 3.
- The Week 2 comparison is one combined run (6 + 4 tasks) and recorded only the total
  fix-cycle count.
- Costs are list-price estimates reported by the Claude Code CLI.
