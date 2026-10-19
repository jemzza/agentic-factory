# Roadmap after Week 3

Proposed 2026-10-19: five core weeks (two of them new stacks, by the owner's request) and one
optional week. Each week follows the Week 3
working rules: phases with a stop for the owner's confirmation; code and tests first, then
live measurements in one block; every number in the results comes from a recorded run.

**Week 3 is closed** (`docs/week3-results.md`). Default roles: Sonnet plans and develops, Opus
reviews; memory on; concurrency 2. One leftover: the live GitHub cycle in `taskflow-demo`
stopped at `budget_exceeded` and waits for the owner's `/retry`.

The cost estimates below were made with Opus in every role. With the chosen Sonnet roles, an
eval repeat costs ≈ $3.2 instead of ≈ $6, so the live runs should come out lower.

## Why this order

Week 3's biggest lesson: **the serious bugs only surfaced in live runs.** Fakes did not
model how the factory talks to the real CLIs. Six defects were found in the final block:

- eval judged runs that ended without the merge gate as errors;
- the A/B harness let task A be auto-approved;
- the planner's agent schema had no `lessons` field;
- git fell back to the owner's keychain;
- spec versions could collide;
- resuming a parallel eval compared task lists in order and was refused.

Hence the order:

1. Trust the measurements (Week 4).
2. Raise quality (Week 5).
3. Close the isolation gap (Week 6).
4. New stacks: Kotlin (Week 7), then iOS (Week 8). They come after Week 4, because a new
   stack must be measured with hidden tests and contract tests, not only run. iOS also comes
   after Week 6, because its sandbox is a macOS VM, a continuation of the isolation work.
5. Scale (Week 9).

Improving quality before the numbers can be trusted is what Week 3 got wrong.

Costs are list-price estimates. The practical limit is the Claude subscription: in Week 3 a
session window held about $10 of work, and the limit was hit 3 times in the final block. The
"windows" column is how many such windows the week's live runs need.

| Week         | Goal                                    | Live runs (estimate)  | Windows | Owner inputs                                                            |
| ------------ | --------------------------------------- | --------------------- | ------- | ----------------------------------------------------------------------- |
| 4            | Trust the numbers                       | ≈ $50–60              | 5–6     | Approve the new tasks; GitHub Actions on the factory repo               |
| 5            | Independent review, lower false success | ≈ $60–70 (+ ≈ $5 API) | 6–7     | A second-vendor provider and key (Gemini API or OpenAI)                 |
| 6            | Agent isolation                         | ≈ $60                 | 6       | Approve the container design and the network allowlist                  |
| 7            | Kotlin (JVM) as a third stack           | ≈ $20–30              | 2–3     | A Kotlin target repository (or approve a new demo project)              |
| 8            | iOS (Swift) as a fourth stack           | ≈ $20–30              | 2–3     | Xcode, ≈ 80 GB of disk for a macOS VM, the VM tool, an iOS demo project |
| 9 (optional) | Operations                              | ≈ $10                 | 1       | A machine for the factory (home server or VM, no public entry)          |

## Week 4 — Trust the numbers

**Goal:** a change that breaks a contract with a real tool is caught by a test, not by a paid
run. Metrics have known uncertainty, and the dashboard shows them clearly.

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
- **Separate planning and implementation budgets.** Week 3's live run in `taskflow-demo`
  stopped at `budget_exceeded`: two planner passes (before and after `/reject`) used half the
  task's $1, and the developer was capped at the rest. Spec revisions get their own budget, so
  a human rejection never shrinks the implementation.
- **Flaky-test detection.** On a gate failure, the failing check runs once more on the same
  commit. A pass on the rerun is recorded as `flaky` (the project's test, not the agent's code)
  and reported. A fix cycle is spent only on a reproducible failure.
- **Dashboard: a clear, professional interface** (the week's last phase, so it shows the new
  metrics and the bigger eval). Still read-only, 127.0.0.1 only, secrets masked, no external
  scripts: charts are server-rendered SVG, so the strict CSP stays.
  - **Overview page:**
    - the latest evals with verified, false success and cost, each with its spread;
    - runs in progress and the node each is at;
    - spending per day and per week;
    - subscription-limit hits.
  - **Trends:** verified, false success and cost per repeat over all evals, with a
    confidence band, so an improvement can be told from noise.
  - **Eval comparison as a heat map:** tasks × repeats, colored by outcome (verified, false
    success, error, clarification), with the difference stated as "beyond / within the
    spread".
  - **Run timeline:** a bar per step (planner → developer → gate → review → merge) with time
    and cost, the event feed beside it.
  - **Memory page:** records per project, their source, and the runs that used them.
  - **Design:**
    - one visual system (spacing, type scale, a small palette);
    - status badges with text, not color alone;
    - light and dark themes;
    - usable at phone width;
    - every number with its unit and, where it exists, its spread;
    - empty and error states that say what to do next.
  - **Checks:**
    - rendering tests per page (including XSS and secret masking);
    - an accessibility check (contrast, labels, keyboard);
    - screenshots of every page in light and dark theme, in `docs/showcase/`.
- **Live block:**
  - re-record the contracts (≈ $1);
  - a new Week 4 baseline: ≈ $15–18 per repeat × 3 with Opus roles, ≈ $9–10 per repeat with
    the chosen Sonnet roles;
  - the dashboard needs no agent runs ($0).

**Done when:**

- the contract tests run in `npm run check`, and each of the six Week 3 bugs is reproduced by
  a test that would have failed;
- the new baseline is recorded with intervals;
- every dashboard page passes its rendering and accessibility checks;
- the screenshots show the new baseline's trends and comparison.

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
- **Model routing by difficulty.**
  - Sonnet by default.
  - Opus for tasks marked hard, and for the retry after a failed gate, a `request_changes`
    review or an invalid answer.
  - Week 3's final eval: Sonnet failed exactly on the hard and the contradictory task.
  - Measured against Sonnet-only and Opus-only on the same eval; config only, the routing
    rule lives in `decide()`.
- **Coverage of the changed lines as a gate signal.** Lines the agent added that no test
  executes are reported to the reviewer, and above a project-set threshold they fail the gate.
  Deterministic, and it works on projects without hidden tests.
- **Memory decision follow-up.** Memory is on since Week 3 (A/B: 8/8 against 0/16). Decide
  what else qualifies as a lesson (fixed review findings), and re-measure with more pairs.
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

## Week 7 — Kotlin (JVM) as a third stack

**Goal:** the factory develops a Kotlin project as reliably as the Node and Python ones,
measured with hidden tests, not only run.

- **A Kotlin target project.** A small JVM service or library, the size of TaskFlow and
  ledgerlite, with its own `CLAUDE.md`, `.factory/config.yaml` and the issue template. It is
  registered in `projects.yaml` and on GitHub.
- **A sandbox profile `jvm21`** (`sandbox/jvm21/`).
  - Pinned JDK and Gradle versions.
  - Dependencies resolved on the host from the lock state into a Gradle cache directory
    (like `node_modules` / `.venv`), so the gate runs `gradle --offline` in the sandbox with
    `--network none`.
  - Checks: `compileKotlin`, `ktlint` or `detekt`, `test` (JUnit 5).
- **Hidden tests and reference patches** for 8–10 Kotlin tasks, using the Week 4 tooling.
  `verify-hidden` must report fail on baseline and pass on reference for every one.
- **Agent commands** in the project config: exact Gradle commands, no wildcards.
- **Not in scope:** Android instrumented tests on an emulator. Android code is covered only as
  far as JVM unit tests reach.
- **Live block:**
  - `project:check`;
  - one GitHub cycle;
  - the Kotlin baseline eval × 3, at ≈ $3–5 per repeat with Sonnet roles.

**Done when:**

- `project:check` passes;
- `verify-hidden` passes for every Kotlin task;
- one live issue → PR → merge on GitHub;
- a Kotlin baseline with intervals is recorded;
- no factory code names the project.

## Week 8 — iOS (Swift) as a fourth stack

**Goal:** the factory develops an iOS app module and verifies it with `xcodebuild` in an
isolated macOS environment.

- **Why it is its own week.** iOS builds and tests need macOS and Xcode (`xcodebuild`, the
  simulator), and the factory's sandbox is a Linux container. The gate needs a **macOS
  sandbox**: a macOS VM on the owner's Apple hardware (Virtualization.framework, e.g. with
  `tart`). Its constraints:
  - no network during checks;
  - only the worktree is shared;
  - discarded after each check, or reset from a clean snapshot.

  Check the tool's real flags first.

- **An iOS target project:** a small SwiftUI app with its logic in a Swift package (unit
  tests with XCTest or Swift Testing), plus a minimal UI layer. It has its own `CLAUDE.md`
  and `.factory/config.yaml`.
- **A sandbox profile `macos-xcode`.**
  - Pinned Xcode and iOS simulator runtime.
  - Swift packages resolved before the check.
  - Checks: `xcodebuild build` and `xcodebuild test` on a pinned simulator, plus `swiftlint`
    if the project uses it.
- **Hidden tests and reference patches** for 6–8 tasks (package-level logic first). UI tests
  are a stretch goal, because simulator UI tests are slow and flaky.
- **Not in scope:** code signing, devices, App Store builds; there are no Apple credentials
  in the factory.
- **Live block:**
  - `project:check`, including VM start and reset times;
  - one GitHub cycle;
  - an iOS baseline eval × 3.

**Done when:**

- the macOS sandbox runs checks with no network and is reset after each run;
- `verify-hidden` passes for every iOS task;
- one live issue → PR → merge;
- an iOS baseline is recorded, with the check time per task reported, since VM checks are
  slower.

## Week 9 (optional) — Operations

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

**Done when:** a week of real issues in all registered projects is processed with no manual
restarts.

## Further ideas (backlog, not scheduled)

Candidates for a week after iOS, or to pull into a week when they fit its goal. Each still
needs its own measurement before it becomes a default.

**Learning from experience**

- **Rules from human edits to agent PRs.** When a person changes the agent's code before
  merging, the planner turns the edit into a lesson, like a `/reject` comment.
- **From memory to project rules.** A lesson that keeps being used is proposed, with the
  owner's confirmation, as a line in the project's `CLAUDE.md` or as a deterministic check.
  Memory then becomes a lasting guarantee.
- **Memory hygiene.** Each record has an age, a use count and conflicts with other records.
  Unused or contradicted records are proposed for removal.

**Working with people**

- **Respond to PR review comments** (a `/fix` command on the PR). The developer addresses a
  human's review comments in the same PR, and the gate and review run again. Today only the
  spec can be sent back.
- **Spec diff between versions.** After `/reject`, the spec comment shows what changed from
  the previous version instead of the whole spec again.
- **Notifications** (Telegram or Slack) for a spec waiting for approval, a PR ready for
  `/merge`, a limit hit or a failure.
- **Large-task decomposition.** The planner can split a big issue into linked smaller issues,
  each a normal factory task, instead of one large change.

**Quality signals**

- **Mutation testing of the agent's tests.** Mutate the changed code and measure how many
  mutants the new tests kill. The mutation score separates "tests exist" from "tests check
  something", and it needs no hidden tests.
- **Real-world tasks.** Beyond the stands: closed issues from small open-source repositories,
  compared with the human fix.
- **A regression suite of the factory's own bugs** (partly in Week 4: each Week 3 bug as a
  permanent test).

**Safety**

- **Dependency changes as a decision.** New packages and lock-file changes in an agent diff
  need the owner's confirmation and pass a vulnerability check (supply chain).
- **Secret scanning of every diff** before a commit, a PR or a merge, on top of the masking
  that exists today.

## Not planned (unless the owner asks)

- New agent roles, microservices, Kubernetes.
- A public server or webhooks.
- Write actions in the dashboard.
- Memory on by default without A/B evidence.
