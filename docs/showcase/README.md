# Start here

**Agentic Software Factory** takes a development task for a target repository and drives it to
a result that is **checked by facts, not by what an agent says**. A planner writes a spec, a
human approves it, a developer agent implements it in an isolated git worktree, and the
factory's own checks run in a Docker sandbox with no network. A read-only reviewer then
checks the diff against the acceptance criteria, and a human merges. In evals, hidden tests
that agents never see decide whether a claimed success is real.

Today it runs against one target, **TaskFlow** (a small Fastify + TypeScript service,
[`fixtures/taskflow/`](../../fixtures/taskflow)), on one machine.

## The loop

A LangGraph state graph, checkpointed in SQLite, so a killed process resumes where it stopped.
Every limit is checked on the conditional edges in one function, `decide()`.

```mermaid
flowchart TD
    START([START]) --> prepare
    prepare -->|ok| plan
    prepare -->|error| report

    plan -->|questions| report
    plan -->|ok| spec_draft
    plan -->|error / timeout / budget| report

    spec_draft -->|valid| spec_approval
    spec_draft -->|invalid, attempt 1| spec_draft
    spec_draft -->|invalid after retry / error| report

    spec_approval{{"⏸ interrupt: spec_approval<br/>status awaiting_spec_approval<br/>(skipped with --auto-approve-spec)"}}
    spec_approval -->|approve| develop
    spec_approval -->|reject, rejections ≤ 2| plan
    spec_approval -->|reject #3| report

    develop -->|ok| gate
    develop -->|error / timeout / budget| report

    gate -->|passed| review
    gate -->|"failed, gateFixCycles < max_gate_fix_cycles (default 2)<br/>gateFixCycles += 1, gate_failure"| develop
    gate -->|"failed, gateFixCycles = max_gate_fix_cycles → gate_failed"| report
    gate -->|sandbox infra error| report

    review -->|approved| report
    review -->|"request_changes, reviewCycles < max_review_cycles (default 1)<br/>reviewCycles += 1, review_feedback"| develop
    review -->|"request_changes, reviewCycles = max_review_cycles → review_rejected"| report
    review -->|error / timeout / budget / provider unavailable| report

    report -->|status success| merge_approval
    report -->|any other status| END([END])

    merge_approval{{"⏸ interrupt: merge_approval<br/>status awaiting_merge_approval<br/>(eval runs stop here)"}}
    merge_approval -->|npm run merge| merge
    merge_approval -->|npm run close| close

    merge -->|merged: main fast-forwarded| END
    merge -->|conflict / gate failed on merge result / main moved| merge_approval
    close --> END
```

Full description: [docs/graph.md](../graph.md).

## Where to look in the code

| File                                                                                                                              | What it does                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [`src/workflow/graph.ts`](../../src/workflow/graph.ts), [`decide.ts`](../../src/workflow/decide.ts)                               | The graph wiring and the single routing rule: cycle budgets, cost, timeout, final status                             |
| [`src/workflow/nodes.ts`](../../src/workflow/nodes.ts)                                                                            | Thin nodes that call existing modules: worktree reset, snapshot, agent steps, report                                 |
| [`src/quality/gate.ts`](../../src/quality/gate.ts), [`sandbox.ts`](../../src/quality/sandbox.ts)                                  | Quality gate: typecheck and tests in Docker (`--network none`), scope and spec-immutability checks                   |
| [`src/runtimes/claude-code.ts`](../../src/runtimes/claude-code.ts), [`provider-errors.ts`](../../src/runtimes/provider-errors.ts) | Claude Code headless adapter (stream-json parsed with Zod; tool policy) and provider-limit detection (`infra_error`) |
| [`src/eval/run-eval.ts`](../../src/eval/run-eval.ts), [`hidden-tests.ts`](../../src/eval/hidden-tests.ts)                         | Eval: hidden tests on a copy of the final worktree; verified, false success and first-pass metrics                   |

## A live run, step by step

Run `20261016-062925-e708`, task `complete-task` ("POST /tasks/:id/complete; 409 for a deleted
task, 404 for an unknown one"), all roles Claude Code Opus, manual approvals. It cost $0.64.
Files: [report.md](live-run/report.md), [spec-approval.md](live-run/spec-approval.md),
[merge-approval.md](live-run/merge-approval.md), [merge.md](live-run/merge.md), and the
database history (approvals, events, steps) in [db-history.md](live-run/db-history.md).

1. **prepare**: an isolated worktree on branch `factory/complete-task-…`, starting from TaskFlow
   `c3ec3cd`, outside the factory repository.
2. **plan → spec_draft**: the planner (32.5 s, $0.20) returns a plan and an OpenSpec change.
   `openspec validate` passes, and the run stops at **spec approval**.
3. **The human rejects the spec**: the spec added a "strict request body" requirement that is
   not in the acceptance criteria. The rejection comment goes back to the planner (approval #1
   in [db-history.md](live-run/db-history.md)).
4. **plan again → new spec → the human approves** (approval #2,
   [spec-approval.md](live-run/spec-approval.md)).
5. **develop**: the developer (25 s, $0.15) implements the approved spec, and the factory commits
   a snapshot (`18703e7`).
6. **gate**: typecheck and tests run in the sandbox and pass. The developer's own claim that
   "checks pass" is never used as evidence.
7. **review**: the read-only reviewer (12 s, $0.15) checks every acceptance criterion with
   file:line evidence, and all three are met ([report.md](live-run/report.md), "Review").
8. **report → merge approval → merge**: a human runs `npm run merge`. The gate runs again on
   the merge result, and `main` moves with a `--no-ff` commit (`519b82c`) that also archives
   the OpenSpec change ([merge.md](live-run/merge.md)).
9. **Hidden tests**: 3 of 4 fail on the baseline tag, and 4 of 4 pass on the merged `main`
   ([docs/week2-results.md](../week2-results.md), "Resilience (Phase 3–5), verified by tests").

## Metrics

TaskFlow, 10 tasks: 9 are to be implemented, and 1 is contradictory, where the correct answer is
`needs_clarification`. **Verified** means the run claimed success _and_ the hidden tests passed.
**False success** means the run claimed success but the hidden tests failed. **First-pass**
means verified with no rework.

| Measurement                                    | Verified     | False success | First-pass   | Fix cycles        | Cost / pass   |
| ---------------------------------------------- | ------------ | ------------- | ------------ | ----------------- | ------------- |
| Week 2, Opus reviewer, 1 run (2 parts¹)        | 100% (10/10) | 0% (0/9)      | 100% (9/9)   | 0                 | $5.82         |
| Week 2, Sol reviewer (OpenCode, OpenAI), 1 run | 90% (9/10)   | 0% (0/8)      | —            | 0.44 avg          | $6.03         |
| Cycle-budget correction, Opus, 3 repeats       | 96.7% ± 5.8% | 0%            | 96.3% ± 6.4% | 0 gate / 0 review | $5.98 ± $0.38 |

¹ The run hit the subscription session limit, and its last 4 tasks were re-run after the reset.
Summaries: [Opus part 1](evals/week2-opus-part1-summary.md),
[Opus part 2](evals/week2-opus-part2-summary.md), [Sol](evals/week2-sol-summary.md),
[cycle budgets](evals/cycle-budgets-summary.md). Analysis:
[docs/week2-results.md](../week2-results.md) and
[docs/cycles-budget-results.md](../cycles-budget-results.md). The one miss in the 3-repeat run
was a provider outage that was recorded as `timeout`; it has been classified as `infra_error`
since `421b588`.

## Honest limitations

- **The reviewer is the same vendor and model as the developer** (Claude Code Opus). The design
  calls for an independent reviewer from another vendor. The OpenCode adapter exists and is
  tested, but it is disabled for now, so the review is less independent than designed.
- **The hidden tests check the acceptance criteria, not the repository's rules.** For example,
  TaskFlow's "unknown body keys → 400" convention is not tested. The Sol reviewer rejected
  changes for breaking it, and the hidden tests passed either way.
- **The factory runs locally.** It is one machine with one target, and tasks run one at a time.
  Checks run in Docker, but the agent itself runs on the host, limited by a per-role tool
  allow-list (see "Known limitation" in the [README](../../README.md)).
- **The suite is saturated for Opus.** At about 100% it can show regressions but not
  improvements, and with only n = 1–3 repeats the spread is wide.

## What's next

GitHub Issues as the task source, and pull requests instead of local merges · several target
projects · parallel task execution · memory across runs · a dashboard for runs and evals ·
Pi as another agent runtime.

## Try it

```bash
npm ci && npm run check          # typecheck, lint, format, unit tests (fake agents, no network)
npm run verify-hidden            # hidden tests fail on the baseline and pass on the reference patches (Docker)
```

The TaskFlow fixture is part of this repository. On first use, the factory materializes it as a
git repository under `FACTORY_WORKDIR` (default `~/agentic-factory-work`), so no submodule or
setup script is needed. Running agents (`npm run run-task`, `npm run eval`) needs an
authenticated Claude Code CLI; see the [README](../../README.md).
