# Week 3 results

Status: **in progress.** Filled phase by phase; the final comparison comes in Phase 8. Design:
[week3-design.md](week3-design.md).

## Phase 1: TaskFlow rules in the hidden tests, Week 3 baseline

### What changed in `evals/`

- **New files only:** `evals/hidden/<id>/<id>.rules.hidden.test.ts` for all 10 tasks, 47 tests.
  They test the TaskFlow repository rules from `fixtures/taskflow/CLAUDE.md` that apply to each
  task, through the public HTTP API: strict request bodies, the error body shape, exact task
  fields, deleted tasks, creation order, `updatedAt` on success and failure. The mapping of rules
  to tasks is in [week3-design.md §2](week3-design.md). Existing hidden test files are unchanged.
- **New rule in `verify-hidden`, checked per test:** every rules test of an `implemented` task
  must fail on `factory-baseline`. The exception is `[guard]` tests, regression guards of
  existing behavior, which must pass there. Every rules test of the clarification task
  (`hard-delete`) must be a passing guard. Mutation check: when the `[guard]` prefix is removed
  from a test that passes on baseline, `verify-hidden` fails with "passes on baseline — it tests
  nothing new".
- **Finding while writing them:** malformed JSON (`{not json`) gets 400 `VALIDATION_ERROR` on
  the baseline, even on routes that do not exist. Fastify parses the body before routing, and
  the app's error handler maps the result. So these four tests are guards, not rules tests for
  the new routes.
- **Reference fixes (requested by the owner):** the references of `complete-task`,
  `reopen-task` and `restore-task` ignored the request body, so `{"unexpected": true}` returned 200. That breaks the rule "Request bodies are strict: unknown keys → 400". They now parse a
  strict empty body (`z.strictObject({})`, an absent body counts as `{}`) and each has a test for
  it in its own test file. The other 6 references already passed every new test.
- `npm run verify-hidden` → **10/10** (Docker sandbox, 2026-10-18).

### `eval:rescore`: the last eval measured with the new hidden tests

`npm run eval:rescore -- eval-20261017-095351` makes no agent calls and costs $0. Each run's
stored final diff (`report.json` → `diff`) was applied to `factory-baseline` = `c3ec3cd`. Then
the hidden tests at factory commit `65a2fa0` (old and new files) were run in the sandbox. All
27 success claims were rebuilt from their diffs: 0 fallbacks to a head commit, 0
`hidden_error`. Output: `runs/eval-20261017-095351/rescore-20261018-002006/`, marked
`rescored`. The original summary is untouched, and the DB has an `evals` row with
`kind = 'rescore'` and `source_eval_id = eval-20261017-095351`.

| Metric (3 repeats, mean ± sample stdev) | Original (Week 2 hidden tests)    | **Rescored = Week 3 baseline**      |
| --------------------------------------- | --------------------------------- | ----------------------------------- |
| Verified rate                           | 96.7% ± 5.8% (10/10, 9/10, 10/10) | **66.7% ± 5.8%** (7/10, 6/10, 7/10) |
| False success rate                      | 0% ± 0% (0/9, 0/8, 0/9)           | **34.7% ± 2.4%** (3/9, 3/8, 3/9)    |
| First-pass rate                         | 96.3% ± 6.4% (9/9, 8/9, 9/9)      | **63.0% ± 6.4%** (6/9, 5/9, 6/9)    |
| Gate / review cycles                    | 0.00 / 0.00                       | 0.00 / 0.00 (unchanged)             |
| Time per task, cost per repeat          | 156.7 s ± 27.4 s, $5.98 ± $0.38   | the same (no re-run)                |

**9 of 27 `verified` became `false_success`**: `complete-task`, `reopen-task` and
`restore-task` in each of the 3 repeats. Every one of them fails the same single test: an
unknown body key on the new `POST /tasks/:id/<action>` route returns 200, where TaskFlow's rules
require 400 `VALIDATION_ERROR`. Every other new rules test passed on every agent implementation.
In Week 2 the Sol reviewer flagged this exact convention, and the Opus reviewer did not. With
every role on Opus, the developer misses it and the reviewer approves it, every time.

The rescore baseline is still `c3ec3cd`. In Phase 2 the `factory-baseline` tag moves to a commit
that only adds `.factory/` and `.github/` files (approved by the owner). The rescore is then
repeated on the new tag to confirm the same outcomes.

Subscription limits hit in Phase 1: **0** (no agent calls).
