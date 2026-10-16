# Week 2 results

Status: **interim** — single-repeat runs only. The `--repeat 3` section is filled in after
the reviewer for it is chosen (see "Open decision").

## What was built

| Phase | Result                                                                                           | Commit    |
| ----- | ------------------------------------------------------------------------------------------------ | --------- |
| 0     | Graph and design (`docs/graph.md`, `docs/week2-design.md`)                                       | `5f23079` |
| 1     | SQLite store (better-sqlite3, migrations, secret masking, import of Week 1 reports)              | `9b47403` |
| 2     | Pipeline runs as a LangGraph.js state graph; one routing rule (`decide.ts`)                      | `b866e85` |
| 3     | SQLite checkpoints, idempotent replay, `npm run resume`                                          | `a0f5aff` |
| 4     | OpenSpec spec drafted by the planner, `openspec validate --strict`, human spec approval gate     | `2f98c02` |
| 5     | Human merge gate: `--no-ff` merge + spec archive in one commit, gate re-run on the merge result  | `da9e2d7` |
| 6     | OpenCode runtime, per-role runtime config, frozen reviewer eval set `evals/review/`              | `34c7e1f` |
| 7     | `eval --repeat N` (shared cost cap, mean ± stdev), reviewer comparison in the graph, this report | see git   |

## Graph equivalence (Phase 2)

The LangGraph pipeline was checked against the Week 1 sequential pipeline on the same
tasks, same models (Opus for all roles), before any new feature was added:

| Metric             | Week 1 baseline `eval-20261015-130103` | Graph `eval-20261015-171000` |
| ------------------ | -------------------------------------- | ---------------------------- |
| Verified rate      | 100% (10/10)                           | 100% (10/10)                 |
| False success rate | 0% (0/9)                               | 0% (0/9)                     |
| Avg fix cycles     | 0                                      | 0                            |
| Avg time per task  | 146.2s                                 | 147.1s                       |
| Total cost         | $5.28                                  | $5.29                        |

## Phase 7 eval: the full Week 2 pipeline

Pipeline: plan → OpenSpec draft + validate → auto spec approval → develop → gate → review →
report, stopping at the merge gate (eval never merges). Planner and developer: Claude Code
Opus. Eval starts from `factory-baseline` = `c3ec3cd` (see "Baseline changed" below).

Two reviewers were run on the same pipeline, one repeat each:

| Metric                    | Baseline (graph, Opus reviewer, Week 1 fixture) | **Sol reviewer** (OpenCode `openai/gpt-6.1-sol`) | Opus reviewer (Claude Code)                      |
| ------------------------- | ----------------------------------------------- | ------------------------------------------------ | ------------------------------------------------ |
| Eval id                   | `eval-20261015-171000`                          | `eval-20261016-113113`                           | `eval-20261016-115810` + `eval-20261016-165136`¹ |
| Verified rate             | 100% (10/10)                                    | **90% (9/10)**                                   | 100% (10/10)                                     |
| False success rate        | 0% (0/9)                                        | 0% (0/8)                                         | 0% (0/9)                                         |
| Avg fix cycles            | 0                                               | 0.44                                             | 0                                                |
| Avg time per task         | 147.1s                                          | 158.3s                                           | 119.1s                                           |
| Total cost                | $5.29                                           | $6.03                                            | $5.82 (+ $0.32 lost)¹                            |
| Hidden files in worktrees | 0                                               | 0                                                | 0                                                |

¹ The Opus-reviewer run hit the Claude subscription session limit on task 7 of 10
(`restore-task`, in the developer step: "You've hit your session limit"). The pipeline
recorded it correctly as `error` and the remaining tasks failed fast. After the limit reset,
the 4 affected tasks were re-run alone (`eval-20261016-165136`) with the same config. The
combined row takes tasks 1–6 from the first run and 7–10 from the second; $0.32 was spent
on the aborted `restore-task` attempt.

### Per task

| Task             | Baseline (hidden) | Sol reviewer                  | Opus reviewer       |
| ---------------- | ----------------- | ----------------------------- | ------------------- |
| `bulk-status`    | verified (11/11)  | **review_rejected**, 2 cycles | verified (11/11)    |
| `complete-task`  | verified (4/4)    | verified (4/4), 1 cycle       | verified (4/4)      |
| `due-date`       | verified (20/20)  | verified (20/20)              | verified (20/20)    |
| `hard-delete`    | needs_clarif.     | needs_clarification           | needs_clarification |
| `pagination`     | verified (19/19)  | verified (19/19)              | verified (19/19)    |
| `reopen-task`    | verified (5/5)    | verified (5/5), 1 cycle       | verified (5/5)      |
| `restore-task`   | verified (6/6)    | verified (6/6)                | verified (6/6)      |
| `search-tasks`   | verified (8/8)    | verified (8/8)                | verified (8/8)      |
| `sort-tasks`     | verified (10/10)  | verified (10/10)              | verified (10/10)    |
| `status-history` | verified (9/9)    | verified (9/9)                | verified (9/9)      |

### Why Sol lost `bulk-status`

The criterion is "the operation is atomic: on any error no task changes". The developer
pre-validated every id (404/409/400 leave all tasks unchanged, with tests). Sol read "any
error" literally and asked, as a blocker, for all-or-nothing behavior even when an injected
`TaskRepository.save` rejects half-way; the developer added compensation, then retries for
the compensation, and Sol still found a failure mode each cycle (a rollback that itself fails).
After 2 fix cycles the run ended `review_rejected`. The Opus reviewer approved the first
version, noting the separate saves as a minor point acceptable for the in-memory repository.
The hidden tests (11/11 on the Opus run) do not require repository-failure atomicity.

### Sol's other change requests were legitimate

On `complete-task` and `reopen-task` Sol rejected the first version because the new
`POST /tasks/:id/complete|reopen` routes ignored the request body, so `{"unexpected": true}`
returned 200. TaskFlow's `CLAUDE.md` says request bodies are strict (unknown keys → 400).
The developer fixed it in one cycle and the runs were verified; Opus did not flag this. The
hidden tests pass either way. This matches the `eval:review` picture: Sol is stricter on
repository conventions and more expensive in cycles, not wrong about them.

## Reviewer eval (`evals/review/`, Phase 6)

15 frozen cases (10 with a planted defect, 5 clean), scoring rules fixed in
`evals/review/README.md` before the first run (manifest commit `57bb30b`).

| Reviewer                    | Recall (strict) | False positive rate | Invalid answers | Cost   | Avg time |
| --------------------------- | --------------- | ------------------- | --------------- | ------ | -------- |
| claude-code:opus            | 100% (10/10)    | 60% (3/5)           | 0               | $1.725 | 18.4s    |
| opencode:openai/gpt-6.1-sol | 100% (10/10)    | 100% (5/5)          | 0               | $0.606 | 30.7s    |

Run `review-eval-20261016-111221`. The first two-reviewer run (`review-eval-20261016-075017`)
is **invalid** and not used: Claude hit the subscription session limit from case `d04`, and
the scorer did not strip a `:line` suffix from OpenCode's `file` field (fixed in `0fcb7e6`;
the scoring rule itself did not change). The "false positives" on clean cases are mostly
test-quality remarks that TaskFlow's conventions do support (missing error-code assertions,
missing error-path tests), and on `c01` Sol asks for a strict request body.

## Resilience (Phase 3–5), verified by tests

- Real `SIGKILL` of a child process during `develop` → `npm run resume` completes the run,
  the diff contains no duplicated changes (mutation check: without the worktree reset the
  line is duplicated and the test fails).
- `SIGKILL` during `gate` → resume re-runs the gate with a correct result; resuming a
  finished run does nothing.
- Spec gate: approve / reject with comment / third reject → `needs_clarification`; one
  repair of an invalid spec with validator output; a developer edit of the approved spec
  fails the gate as a policy violation.
- Merge gate: nothing merged automatically; `--no-ff` + archive in one commit; baseline tag
  untouched; idempotent second merge; conflict / main moved / gate failure on the merge
  result leave `main` untouched and wait for a human.
- Live: run `20261016-062925-e708` (reject → new spec → approve → success) merged into
  TaskFlow `main` as `519b82c1d6`; hidden tests fail 3/4 on the tag and pass 4/4 on `main`;
  `verify-hidden` 10/10.

## Spend: actual vs estimate (list-price estimates from the CLIs)

| Item                                      | Estimate (Phase 0)                      | Actual                 |
| ----------------------------------------- | --------------------------------------- | ---------------------- |
| Phase 2 equivalence eval                  | $5–6                                    | $5.29                  |
| Phase 4–5 live run (`complete-task`)      | —                                       | $0.64                  |
| Phase 6 `eval:review` (3 runs, 1 invalid) | "small"; later ~$7 per two-reviewer run | $5.69                  |
| Phase 6 live OpenCode isolation probes    | —                                       | < $0.10 (not itemized) |
| Phase 7 eval, Sol reviewer                | ~$6                                     | $6.03                  |
| Phase 7 eval, Opus reviewer (2 parts)     | ~$6                                     | $6.15                  |
| **Total so far**                          | $30–40 for the week                     | **≈ $23.8**            |

No task exceeded its estimate by ≥ 50% (the stop rule from Phase 0); the most expensive run
was Sol's `bulk-status` at $1.19 (3 developer and 3 reviewer calls) against ~$0.6 for the
same task with one review. `--repeat 3` (~$18) would bring the week to about $42.

## What did not work / caveats

- **Baseline changed.** Phase 4 added `openspec/` and an `openspec/` rule to the fixture's
  `CLAUDE.md`, so the TaskFlow baseline commit differs between Week 1 (`8919252`) and Week 2
  (`c3ec3cd`). The comparison above is across different baselines and, from Phase 4 on, a
  longer pipeline (an extra spec step per task); differences in time/cost are not only the
  reviewer's.
- **Single repeats.** One run per reviewer; one task flipping is a 10-point swing.
  Variance is unmeasured until `--repeat 3`.
- **Subscription limits** interrupted two measurements (`eval:review` and the Opus eval).
  The factory handled both as `error` steps, but long evals need either API billing or
  splitting runs across limit windows.
- **The suite is saturated for Opus** (10/10); it cannot show improvements, only regressions.

## Open decision

Which reviewer to use for `--repeat 3` and as the default:

- **Sol (OpenCode)** — an independent reviewer from another vendor (Week 2 requirement),
  stricter on conventions, ~3× cheaper per review, but 90% vs 100% verified here because it
  can demand requirements beyond what the task can reasonably deliver.
- **Opus (Claude Code)** — 100% verified, fewer cycles, faster; same vendor as the developer.
