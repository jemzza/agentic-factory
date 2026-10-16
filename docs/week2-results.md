# Week 2 results

Status: **final for Week 2.** Default reviewer: Sol (OpenCode), chosen by the reviewer eval.
The main configuration has **1 complete repeat + 1 partial repeat (4/10 tasks)**: the OpenAI
budget for Sol ran out during repeat 2. The remaining repeats are resumable (see below).

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
| 7     | `eval --repeat N` (shared cost cap, mean ± stdev), reviewer comparison in the graph, this report | `2e18901` |
| 7     | `infra_error` for provider limits (excluded from metrics), `eval --resume`, migration 003        | `4df772c` |

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

## Reviewer choice: by the reviewer eval, not by verified rate

The reviewer is chosen on `evals/review/` — diffs with known, planted defects — by recall and
false positive rate. Verified rate is not a reviewer metric: it penalizes a strict reviewer
(every change request costs a cycle and can end in `review_rejected`) and rewards one that
approves everything, as long as the developer is good. In the pipeline runs below, Opus
approved all 10 tasks with 0 cycles and missed a TaskFlow convention violation that Sol caught
(see "Sol's other change requests"). **Default reviewer: Sol.**

| Reviewer (eval:review, 15 frozen cases) | Recall (strict) | False positive rate | Invalid answers | Cost   | Avg time |
| --------------------------------------- | --------------- | ------------------- | --------------- | ------ | -------- |
| opencode:openai/gpt-6.1-sol             | 100% (10/10)    | 100% (5/5)          | 0               | $0.606 | 30.7s    |
| claude-code:opus                        | 100% (10/10)    | 60% (3/5)           | 0               | $1.725 | 18.4s    |

Equal recall; Sol flags every clean case, Opus 3 of 5 — mostly convention-backed test-quality
remarks (details in "Reviewer eval" below). Sol is ~3× cheaper per review and from another
vendor than the developer, which is the point of an independent reviewer.

## Phase 7 eval: the full Week 2 pipeline

Pipeline: plan → OpenSpec draft + validate → auto spec approval → develop → gate → review →
report, stopping at the merge gate (eval never merges). Planner and developer: Claude Code
Opus. Eval starts from `factory-baseline` = `c3ec3cd` (see "Baseline changed" below).

### Sol vs Opus in the pipeline — one run each, not statistically meaningful

Each reviewer ran the suite **once**. 9/10 vs 10/10 is a single task (`bulk-status`); with one
run per configuration this difference is not evidence that one reviewer is better. It is shown
to explain _how_ the reviewers differ, not to rank them.

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

### Main configuration (Sol reviewer), 3 repeats

Eval `eval-20261016-113113`, planned 3 repeats. **Not completed:** the OpenAI budget for the
Sol reviewer ran out during repeat 2, and the run was stopped by hand before task 5
(`pagination`, in its planner step). No statistics across repeats are claimed: r1 is the only
complete pass; r2 covers 4 of 10 tasks.

| Task            | r1 (factory `2e18901`)                 | r2 (factory `351827d`¹)                | Same outcome |
| --------------- | -------------------------------------- | -------------------------------------- | ------------ |
| `bulk-status`   | review_rejected, 2 cycles, 342s, $1.19 | review_rejected, 2 cycles, 333s, $1.27 | yes          |
| `complete-task` | verified 4/4, 1 cycle, 124s, $0.46     | verified 4/4, 1 cycle, 240s, $0.55     | yes          |
| `due-date`      | verified 20/20, 0 cycles, 195s, $0.80  | verified 20/20, 0 cycles, 195s, $0.83  | yes          |
| `hard-delete`   | needs_clarification, 20s, $0.05        | needs_clarification, 25s, $0.05        | yes          |
| tasks 5–10      | 6 × verified                           | not run                                | —            |

¹ Recorded as `351827d…-dirty`: the only uncommitted tracked file was this document.
Between r1 and r2 only docs and the error classification of provider-refused calls changed
(`4df772c`, `351827d`); see "Spend" for why r1 counts as repeat 1.

What r2 shows despite being partial: Sol's behavior **reproduces exactly**. On `bulk-status`
it again demanded all-or-nothing writes under repository failures and moved to a new failure
mode each cycle (compensation → failing compensation → a repository without the new
`saveMany`), ending `review_rejected`. On `complete-task` it again required a strict request
body on the new route (blocker, fixed in one cycle). So the `bulk-status` loss is systematic
reviewer behavior, not noise — the target of the calibration correction below.

To finish the measurement once the OpenAI budget is restored (~$9; r1 and the 4 decided r2
tasks are kept):

```bash
npm run eval -- --resume eval-20261016-113113 --repeat 3 --cost-cap 21
```

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

| Phase 7 eval, Sol reviewer, r2 (4 of 10 tasks) | ~$6 for a full repeat | $2.69 |
| Lost to the `4df772c` schema bug + interrupted planner steps | — | ~$0.2 (+ unknown, small) |
| **Total** | $30–40 for the week | **≈ $26.7** |

No task exceeded its estimate by ≥ 50% (the stop rule from Phase 0); the most expensive run
was Sol's `bulk-status` at $1.19 (3 developer and 3 reviewer calls) against ~$0.6 for the
same task with one review. Instead of 3 fresh repeats (~$18, week ≈ $42) the existing Sol run
was kept as repeat 1 and 2 repeats were to be added (~$12): it was verified comparable — run at
factory commit `2e18901`, and since then only docs, `.env.example` and the error
classification of provider-refused calls changed; prompts, config, CLI versions (Claude Code
2.1.300, OpenCode 1.19.0) and the baseline commit `c3ec3cd` are the same.

## What did not work / caveats

- **Baseline changed.** Phase 4 added `openspec/` and an `openspec/` rule to the fixture's
  `CLAUDE.md`, so the TaskFlow baseline commit differs between Week 1 (`8919252`) and Week 2
  (`c3ec3cd`). The comparison above is across different baselines and, from Phase 4 on, a
  longer pipeline (an extra spec step per task); differences in time/cost are not only the
  reviewer's.
- **Variance not measured.** One complete run per reviewer and a partial second Sol run; one
  task flipping is a 10-point swing. The reviewer comparison in the pipeline is not evidence
  of which reviewer is better — `eval:review` is.
- **A bug of mine cost a run.** `4df772c` declared `api_error_status` as an optional number,
  but every live success result carries `null`, so every agent call failed to parse. Caught
  on the first task of the resumed eval and stopped; fixed in `351827d`. The fake Claude
  process had not mirrored the live output; real result events are now fixtures with a test.
  The invalid pass is kept as `runs/eval-20261016-113113/r2-invalid-null-schema-bug/`; its two
  runs (`20261016-171705-daf3` error, `20261016-171750-850f` left `running`) stay in the DB as
  recorded and are not part of any summary. The killed `pagination` run of r2
  (`20261016-173322-8ac5`) is likewise left `running`.
- **OpenCode provider errors are not yet `infra_error`.** Their event shape has not been
  observed live, so an exhausted OpenAI key during a run would be recorded as `error`.
- **Subscription limits** interrupted two measurements (`eval:review` and the Opus eval),
  both recorded as plain `error`, indistinguishable from a factory failure. Fixed in
  `4df772c`: provider-refused calls are `infra_error`, excluded from metrics, and an
  interrupted eval continues with `npm run eval -- --resume <evalId>` instead of a manual
  re-run of the failed tasks. Not covered yet: OpenCode provider errors (shape not observed).
- **Hidden tests do not check repository conventions.** Sol's legitimate strict-body findings
  on `complete-task`/`reopen-task` are invisible to the hidden tests, so the eval cannot reward
  a reviewer for them. Kept as is for Week 2, so that all repeats use the same tests.
- **The suite is saturated for Opus** (10/10); it cannot show improvements, only regressions.

## Next: reviewer calibration (correction after Week 2)

One correction with its own before/after measurement, so that "before vs after calibration"
is a clean comparison on the same tests:

1. **Hidden tests for task-relevant TaskFlow conventions** (e.g. unknown body key → 400 on the
   new routes). An extension of the hidden tests, not a weakening; made before the "after"
   measurement and called out in the commit, as `CLAUDE.md` requires.
2. **Re-check on the next cycle.** The reviewer gets its previous findings and first checks
   whether they were fixed. A new blocker is allowed only if the fix introduced it (a
   regression) or if it is a criterion violation reproducible through the public API — this is
   the `bulk-status` failure: the reviewer moved the goalposts every cycle.
3. **Blocker defined in the prompt:** a violation of an acceptance criterion, the spec or the
   repository rules in a realistic scenario. Hypothetical infrastructure failures (storage
   failing mid-operation in an in-memory implementation) are `major`/`minor`, never blockers.
4. **Ambiguity is resolved in the spec, not in review.** "On any error" must become concrete
   scenarios in the OpenSpec change, and the reviewer checks against those. Task criteria are
   not changed.
5. **Diagnostic metric: over-rejection.** Hidden tests also run on `review_rejected` tasks (not
   counted as verified); "rejected runs that would pass the hidden tests" shows how much the
   reviewer over-rejects. `bulk-status` in r1 is exactly such a case.

Also deferred until after Week 2: separate `max_gate_fix_cycles` / `max_review_cycles` budgets
and the first-pass rate (the earlier correction request).
