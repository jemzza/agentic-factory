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

## Phase 2: many projects

### What changed

- **One factory, many projects.** `projects.yaml` registers projects. Each project keeps its
  rules in its own `.factory/config.yaml`: sandbox profile, dependency files, host install,
  gate checks, the developer's exact commands and self-check, conventions file, allowed and
  protected paths, budget defaults, target branch. Commands are plain words, and shell syntax
  is a config error.
- **Rules come from the committed tree.** The config and the conventions file are read with
  `git show` from the project's main clone: the target branch for interactive runs, the
  baseline tag for eval. They are frozen in the run state, never read from a worktree. A test
  covers this: an uncommitted edit of `CLAUDE.md` and `.factory/config.yaml` in the clone and a
  developer's edit of `CLAUDE.md` change nothing. The developer's edit fails the gate as a
  protected-path violation, and the rework restores the file.
- **Sandbox profiles:** `sandbox/node22/` (Node 22.23.3) and `sandbox/python312/` (Python
  3.12.15), each base image pinned by digest. Every profile has a Dockerfile and a bootstrap
  script.
- `project_id` is on runs, events, approvals, evals and baselines (migration 006). All 85
  earlier runs got `taskflow`. Task files may omit scope and budget, which then default to the
  project's.
- **TaskFlow moved to the general mechanism.** It got `.factory/config.yaml` and
  `.github/ISSUE_TEMPLATE/factory-task.yml`, and `evals/eval.config.yaml` describes the stand:
  the hidden test directory, script and reference check. `src/no-project-coupling.test.ts`
  fails if `src/`, `scripts/`, `prompts/`, `sandbox/` or `factory.config.ts` name it. The
  mutation check (an added mention) is caught.
- `npm run project:check -- <id>` checks the config at the target branch, the files it names,
  the sandbox profile and image, the host install, and runs every gate check on a clean export
  of the target branch in the sandbox. No agents are called.
- **Per-role models:** each role's model goes to `claude --model` (flag checked in
  `claude --help`). Every agent step now also records `modelsUsed`, the resolved model ids
  from the result event (`opus` → `claude-opus-5-5`). The candidate config is in
  `factory.sonnet-dev.config.ts` and is selected with `FACTORY_CONFIG=`.
- **Host sleep counts as infrastructure.** If the host was asleep during a step and the step
  did not succeed, the run ends `infra_error`, not `timeout`. Time spent asleep does not count
  against the deadline. Details are under "Interrupted eval" below.

### New factory-baseline (approved by the owner)

The fixture now contains `.factory/` and `.github/`, so `factory-baseline` moved from
`c3ec3cd` to `8e6e21f`. The move is recorded in `baselines` with `project_id = taskflow`.
`npm run eval:rescore -- eval-20261017-095351` on the new tag: all 27 stored diffs applied, 0
fallbacks, and **0 outcome differences** from the rescore on `c3ec3cd`. The Week 3 baseline
numbers stand.

### Checks run

| Command                               | Result                                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| `npm run verify-hidden`               | 10/10                                                                                        |
| `npm run test:sandbox`                | 9/9. One earlier run timed out on a test that pulls a nonexistent image (Docker Hub latency) |
| `npm run project:check -- taskflow`   | ready (typecheck, test pass in `node22`)                                                     |
| `npm run project:check -- ledgerlite` | ready (ruff, mypy --strict, pytest pass in `python312`)                                      |
| `npm run check`                       | exit 0, 317 tests                                                                            |

### Second project: ledgerlite

A separate git repository at `~/Documents/2026/ledgerlite`: a double-entry bookkeeping
library, standard library only. Rules are in its `CLAUDE.md`: `Decimal` money, balanced
transactions, stable error codes, atomic calls, immutable records. 29 tests; the dev tools are
hash-locked (`requirements-dev.lock`, 280 hashes). The tasks are `.factory/tasks/balance-as-of.yaml`
and `reverse-transaction.yaml`.

**Live run through the CLI:** `npm run run-task -- --project ledgerlite
~/Documents/2026/ledgerlite/.factory/tasks/balance-as-of.yaml --auto-approve-spec`, run
`20261018-010150-2b00`, every role Opus:

| Step               | Result                                                                    |
| ------------------ | ------------------------------------------------------------------------- |
| planner + spec     | ok, $0.205, 38 s; OpenSpec change valid on the first draft                |
| developer          | ok, $0.235, 50 s; `src/ledgerlite/ledger.py`, new `tests/test_balance.py` |
| gate (`python312`) | passed: lint 0, typecheck 0, test 0                                       |
| reviewer           | approve (1 minor remark), $0.149, 18 s                                    |
| total              | **success, $0.59, 111 s**, waiting at the merge gate                      |

The code rejects a `datetime` explicitly. `datetime` is a subclass of `date`, which is the
trap in this task's criteria. The run was not merged: merging is the owner's decision.

### Interrupted evals: the host slept (no measurement in this phase)

Two equivalence evals were started on the new baseline. Neither is a measurement, and neither
is used.

- `eval-20261018-030253`. The lid was closed on battery (8 %) one minute into the developer
  step of `complete-task` (pmset: "Clamshell Sleep" 06:06:14, wake 07:42:05). The step's
  15-minute timeout fired after 96 minutes of sleep, and the factory recorded `timeout`. The
  next planner call ran in dark wakes without network (only `api_retry`) and ended
  `infra_error`; the pass stopped. Since `a9c543b`, a step that fails across a host suspension
  is `infra_error` and slept time does not count against the deadline, so this cannot be
  recorded as a quality outcome again.
- `eval-20261018-054724` (with the fix, under `caffeinate -ims`, on AC power). **Stopped by the
  owner's decision** after 4 of 10 tasks: every measurement moves to one block at the end (see
  [week3-design.md §11](week3-design.md)). In the DB the eval is `interrupted`, and the
  `pagination` run that was in flight is left `running`. Its 4 finished tasks are not a
  result. For the record only: they repeat the Week 3 baseline pattern (`complete-task` is
  `false_success` on the strict-body rule, the other three are correct).

Spend in Phase 2: live ledgerlite run $0.59, the interrupted evals $0.87 + $2.12, about $3.6 in
total (list price). Subscription limits hit: 1, by the interactive session that builds the factory; no factory
run was refused by the provider. Host sleep interrupted 1 eval.
