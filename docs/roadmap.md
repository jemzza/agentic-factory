# Roadmap after Week 3

Proposed 2026-10-19: three core weeks and one optional week. Each week follows the Week 3
working rules: phases with a stop for the owner's confirmation; code and tests first, then
live measurements in one block; every number in the results comes from a recorded run.

**Before Week 4:** close Week 3's final block. That means the live GitHub cycle in two
projects, the memory A/B conclusion, the owner's decisions, the final
`eval --repeat 3 --concurrency 2` and the week's report.

## Why this order

Week 3's biggest lesson: **the serious bugs only surfaced in live runs.** Fakes did not
model how the factory talks to the real CLIs. Five defects were found in the final block:

- eval judged runs that ended without the merge gate as errors;
- the A/B harness let task A be auto-approved;
- the planner's agent schema had no `lessons` field;
- git fell back to the owner's keychain;
- spec versions could collide.

Hence the order:

1. Trust the measurements (Week 4).
2. Raise quality (Week 5).
3. Close the isolation gap (Week 6).
4. Scale (Week 7).

Improving quality before the numbers can be trusted is what Week 3 got wrong.

Costs are list-price estimates. The practical limit is the Claude subscription: in Week 3 a
session window held about $10 of work, and the limit was hit 3 times in the final block. The
"windows" column is how many such windows the week's live runs need.

| Week         | Goal                                    | Live runs (estimate)  | Windows | Owner inputs                                                   |
| ------------ | --------------------------------------- | --------------------- | ------- | -------------------------------------------------------------- |
| 4            | Trust the numbers                       | ≈ $50–60              | 5–6     | Approve the new tasks; GitHub Actions on the factory repo      |
| 5            | Independent review, lower false success | ≈ $60–70 (+ ≈ $5 API) | 6–7     | A second-vendor provider and key (Gemini API or OpenAI)        |
| 6            | Agent isolation                         | ≈ $60                 | 6       | Approve the container design and the network allowlist         |
| 7 (optional) | Operations                              | ≈ $10                 | 1       | A machine for the factory (home server or VM, no public entry) |

## Week 4 — Trust the numbers

**Goal:** a change that breaks a contract with a real tool is caught by a test, not by a paid
run. Metrics have known uncertainty.

- **Contract tests against the real CLIs.**
  - Record short live sessions of `claude` (stream-json with `--json-schema`, a limit error),
    Pi (JSON events, a provider error) and `gh` (paginated lists, errors). They are stored
    as fixtures with their tool versions.
  - The fakes are checked against these recordings, and the agent schemas against what the
    factory reads. The `lessons` bug would have been caught here.
  - A version bump of a tool requires re-recording.
- **A bigger eval.**
  - 25–30 tasks instead of 10, across both stands.
  - `ledgerlite` gets its own hidden tests and reference patches, checked by
    `verify-hidden`, so the second stack is measured and not only smoke-tested.
  - The task mix keeps implementable, contradictory (`needs_clarification`) and
    convention-sensitive tasks.
- **Statistics.**
  - 3 repeats by default.
  - The summary gives confidence intervals for verified, false success and first pass.
  - `eval:compare` states whether a difference is beyond the spread.
- **CI.** `npm run check` on every push (GitHub Actions on the factory repository, no
  secrets), so a green check no longer depends on the laptop's load.
- **Live block:**
  - re-record the contracts (≈ $1);
  - a new Week 4 baseline, ≈ $15–18 per repeat × 3.

**Done when:**

- the contract tests run in `npm run check`, and each of the five Week 3 bugs is reproduced
  by a test that would have failed;
- the new baseline is recorded with intervals.

## Week 5 — Independent review, lower false success

**Goal:** false success below 10% at the same or lower cost. Week 3: 22%, mostly one project
rule ("strict request body") that the Opus reviewer approved every time.

- **A reviewer from another vendor with proven recall.**
  - Pi with a strong second-vendor model, Gemini through its API or OpenAI once the owner
    re-enables it. Config only; the runtime exists.
  - Order: `eval:review` (recall ≥ Opus, false positive rate ≤ Opus), then a full eval.
  - The Week 3 local 7B reviewer stays as a $0 fallback only.
- **Deterministic rule checks before review.**
  - Project rules that are checkable (body strictness, error codes, status conventions)
    become gate checks or generated tests from the project's own rule list.
  - A rule is then not left to a model to notice.
  - This stays project-owned: the rules live in the project's `.factory/`, not in the
    factory code.
- **Memory decision follow-up.** If the Week 3 A/B shows an effect, decide what else
  qualifies as a lesson (fixed review findings), and re-measure with more pairs.
- **Live block:**
  - `eval:review` for each reviewer candidate (≈ $2–4);
  - one eval per candidate (≈ $15–18);
  - the Week 5 baseline × 3 (≈ $45–55);
  - the second vendor's API costs (≈ $5).

**Done when:** false success is below 10% over 3 repeats, with recall of the chosen reviewer
not below Opus's on `evals/review/` (and a few new review cases).

## Week 6 — Agent isolation

**Goal:** a successful prompt injection gives no access to the owner's files, keys or
network. Today the agent runs on the host with the owner's permissions; this is a documented
limitation.

- **Claude Code inside a container.**
  - The container sees the worktree only, read-write.
  - It has no home directory, no SSH keys, no `.env` and no GitHub token.
  - The subscription credentials are scoped to the container. Check what Claude Code
    supports first; no flags are guessed.
- **Network egress allowlist:** the model API only; everything else is blocked and logged.
- **Pi's guard extension stays.** The container adds the operating-system boundary that
  Pi's docs recommend.
- **Tests:**
  - adversarial tasks (read `~/.ssh`, `cat .env`, `curl` out, write outside the worktree)
    must fail and be recorded as permission denials;
  - an eval shows quality and cost unchanged within the spread.
- **Live block:**
  - the adversarial checks (≈ $2);
  - an eval × 3 in the container (≈ $45–55).

**Done when:**

- the adversarial suite passes;
- the eval is not worse than the Week 5 baseline;
- README's "Known limitation: the agent runs on the host" is removed.

## Week 7 (optional) — Operations

**Goal:** the factory runs unattended without the owner's laptop.

- **A dedicated machine** (home server or VM): still polling only, no webhooks, no public
  entry. The dashboard is reachable over SSH tunnel only.
- **A run scheduler** that knows the subscription windows:
  - it queues work;
  - it waits for the limit reset;
  - it respects a daily budget;
  - it reports every limit hit.

  This needs the owner's go-ahead: the rules say no queues until planned.

- **Dashboard trends** of the main metrics across evals and weeks, still read-only.

**Done when:** a week of real issues in both projects is processed with no manual restarts.

## Not planned (unless the owner asks)

- New agent roles, microservices, Kubernetes.
- A public server or webhooks.
- Write actions in the dashboard.
- Memory on by default without A/B evidence.
