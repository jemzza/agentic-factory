# Agentic Software Factory

Takes a development task against a target repository and drives it to a **verified** result:

1. **Planner** — explores the code read-only and returns a structured plan plus an
   **OpenSpec change** (requirements grounded in the acceptance criteria), or asks questions.
2. **Spec approval** — a human approves or rejects the spec (`--auto-approve-spec` in eval).
3. **Developer** — implements the approved spec in an isolated git worktree.
4. **Quality Gate** — typecheck and tests run by the factory (not the agent) in a Docker
   sandbox with `--network none`, plus scope and spec-immutability checks of the diff.
5. **Reviewer** — read-only review of the diff against the spec and the acceptance criteria.
   The architecture intends a model from **another vendor** (OpenCode). **Currently every role,
   the reviewer included, is Claude Code Opus 5.5**: the OpenCode reviewer is disabled by the
   project owner's decision, so the review is less independent than designed.
6. **Report**, then **merge approval** — a human merges or closes; the gate re-runs on the
   merge result before `main` moves. Nothing is ever merged automatically.

> Status: Week 2 + the cycle-budget correction. The loop is a LangGraph.js state graph with
> SQLite checkpoints (resume after a crash), OpenSpec specs with an approval gate, a merge
> gate, separate gate and review fix budgets, and a first-pass metric. Results:
> [docs/week2-results.md](docs/week2-results.md),
> [docs/cycles-budget-results.md](docs/cycles-budget-results.md).
> **Reviewing this repository? Start with [docs/showcase/README.md](docs/showcase/README.md).**

## Architecture

```mermaid
flowchart TD
    START([START]) --> prepare --> plan
    plan -->|questions| report
    plan --> spec_draft
    spec_draft -->|invalid, one retry| spec_draft
    spec_draft --> spec_approval{{"⏸ spec_approval"}}
    spec_approval -->|reject ≤ 2| plan
    spec_approval -->|approve| develop --> gate
    gate -->|failed, cycle < max| develop
    gate -->|passed| review
    review -->|changes requested, cycle < max| develop
    review -->|approved| report
    report -->|success| merge_approval{{"⏸ merge_approval"}}
    report -->|any other status| END([END])
    merge_approval -->|merge| merge
    merge_approval -->|close| close --> END
    merge -->|merged| END
    merge -->|conflict / gate failed / main moved| merge_approval
```

Errors, timeouts and budget stops from any node go to `report`. The full graph with every
edge, node table and idempotency rules: [docs/graph.md](docs/graph.md); design decisions:
[docs/week2-design.md](docs/week2-design.md).

- **The graph routes, nodes execute.** `src/workflow/decide.ts` is the single routing rule
  (transitions, limits on edges, errors); `src/workflow/nodes.ts` holds thin nodes that call
  `agents/`, `git/`, `quality/`, `spec/`, `runtimes/`. The edges are tested against
  `docs/graph.md`.
- **State and checkpoints:** `data/factory.db` (better-sqlite3, migrations in `migrations/`)
  holds runs, steps, attempts, events, approvals, baselines and evals; LangGraph's
  `SqliteSaver` writes a checkpoint after every node (`thread_id = runId`). Secrets are masked
  before anything is stored.
- **Idempotent replay:** a node that changes files first resets the worktree to the last
  committed head (path-guarded to managed worktrees), so a node re-run after a crash never
  works on top of partial changes.
- `runtimes/` — `AgentRuntime` contract; `claude-code.ts` (headless `claude -p`),
  `opencode.ts` (`opencode run --format json`, read-only roles only), `pi.ts` (`pi --mode json
-p`, read-only roles only, with the `pi-guard.ts` extension), per-role tool policy.
- `schemas/` — Zod at every boundary: tasks, specs, config, agent answers, steps, reports,
  eval summaries. An answer that does not match its schema is a step error, never repaired.
- `spec/openspec.ts` — renders the planner's spec JSON into `openspec/changes/<taskId>/`,
  `openspec validate --strict`, `openspec archive` at merge time.
- **Projects** (Week 3): the factory knows no project. `projects.yaml` registers them; each
  project keeps its rules in its own `.factory/config.yaml` (sandbox profile, install, gate
  checks, developer commands, conventions file, allowed and protected paths, budget defaults,
  target branch). The factory reads it with `git show` from the target branch as committed,
  never from an agent's worktree, and freezes it in the run state. A test fails if factory
  code names a project.
- `fixtures/taskflow/` — the eval stand (Fastify + TypeScript), a registered project like any
  other; `evals/eval.config.yaml` says how its hidden tests run. Materialized as a real git
  repo under `FACTORY_WORKDIR`; eval starts from its immutable `factory-baseline` tag and
  never uses a remote. Second project: `ledgerlite` (Python 3.12, pytest, mypy, ruff), a
  separate repository.
- `dashboard/` — read-only web view (Fastify, server-rendered HTML, 127.0.0.1 only).
- `memory/` — optional project memory (Week 3): confirmed knowledge of a project, given to
  the planner of later runs of that project only. See [Project memory](#project-memory-optional).
- `evals/tasks/` (visible) · `evals/hidden/` (hidden tests + eval metadata) ·
  `evals/reference/` (reference patches) — the last two are never reachable from agents.
  `evals/review/` — frozen reviewer evaluation set (15 diffs with known defects / clean).

### Statuses and limits

`needs_clarification` · `gate_failed` · `review_rejected` · `timeout` · `budget_exceeded` ·
`error` · `infra_error` · `awaiting_spec_approval` · `awaiting_merge_approval` → `merged` |
`closed`. Every step has a timeout capped by the task deadline; each agent call gets only the
remaining budget; at most `max_gate_fix_cycles` (default 2) gate→develop and, separately,
`max_review_cycles` (default 1) review→develop cycles (each ≤ 2); at most 2 spec
rejections and one spec repair attempt. A run reaches `awaiting_merge_approval` only if the
sandboxed checks exit 0 and the reviewer's structured verdict approves with every criterion
met. In eval, that success claim is checked by hidden tests: `verified` or `false_success`.

**Cycle budgets** (`budget` in `task.yaml`; defaults and the cap are defined once in
`src/schemas/task.ts`):

```yaml
budget:
  max_gate_fix_cycles: 2 # reworks after a failed gate (typecheck, tests, scope, policies)
  max_review_cycles: 1 # reworks after reviewer request_changes
  max_cost_usd: 1.0
  timeout_minutes: 15
```

The two counters (`gateFixCycles`, `reviewCycles`) are independent graph state: they are
checkpointed and restored on resume, and each is checked on its own edge in `decide()`. A
rework after review goes through the gate again, and a gate failure there spends the gate
budget. The developer is told which case it is in (`gate_failure` with the failing command
output, or `review_feedback` with the reviewer's findings). Cost and active-time limits apply
on top: whichever is reached first stops the run. Spec rejections have their own limit. The
legacy shared `max_fix_cycles` is rejected with an error that names the new fields.

**`infra_error`**: the model provider refused or did not answer the call (subscription usage
limit, API rate limit, overload, unreachable API). It is detected in
`src/runtimes/provider-errors.ts`, the one place for these patterns, which is tested on
recorded CLI output. It is not a factory result: it is excluded from every quality metric and
shown on its own line, and the eval stops and keeps its partial results. Continue with
`npm run eval -- --resume <evalId>` after the limit resets; tasks already decided are not
re-run.

**First-pass rate**: the share of tasks that are `verified` by the hidden tests with 0 gate fix
cycles and 0 review cycles. The denominator is the tasks whose correct outcome is an
implementation. Contradictory tasks (correct outcome `needs_clarification`) are shown on their
own line, and `infra_error` is excluded. Human spec rejections do not count; they are recorded
as `specRevisions`.

## How to run

```bash
npm ci
cp .env.example .env          # optional paths; OPENAI_API_KEY only if the OpenCode reviewer is re-enabled
claude auth status            # the Claude Code CLI must be logged in
```

| Command                                                                                | What it does                                                                           |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `npm run run-task -- [--project <id>] <task.yaml \| evalTaskId> [--auto-approve-spec]` | Run one task in a project from its target branch; stops at spec approval               |
| `npm run factory:watch [-- --once] [-- --interval <s>]`                                | Poll GitHub: issues → runs, comments → commands, PRs; one instance; Ctrl+C is graceful |
| `npm run project:check -- <projectId>`                                                 | Config, sandbox image, host install, gate checks on a clean target branch (no agents)  |
| `npm run approve -- <runId> spec`                                                      | Approve the spec and continue to development                                           |
| `npm run reject -- <runId> spec --comment "…"`                                         | Send the spec back to the planner with the comment (≤ 2 times)                         |
| `npm run merge -- <runId>`                                                             | Merge a successful run: `--no-ff` + spec archive, gate on the merge result, then ff    |
| `npm run close -- <runId> --comment "…"`                                               | Close a successful run without merging                                                 |
| `npm run resume -- <runId>`                                                            | Continue an interrupted run from its last checkpoint                                   |
| `npm run dashboard [-- --port N]`                                                      | Read-only dashboard on `http://127.0.0.1:N` (default 4317): runs, a whole run, evals   |
| `npm run runs [-- <limit>]`                                                            | List recent runs from the database                                                     |
| `npm run eval [-- [--repeat N] [--cost-cap USD] <taskId>...]`                          | Eval suite from `factory-baseline`, N repeats, hidden-test verification                |
| `npm run eval -- --concurrency N [...]`                                                | Run N tasks in parallel (per-project git lock, shared cost cap, pause on infra_error)  |
| `npm run eval -- --resume <evalId> [--repeat N]`                                       | Continue an eval interrupted by a provider limit and/or add repeats up to N            |
| `npm run eval:review [-- --only <runtime>]`                                            | Compare reviewers on `evals/review/` (recall, false positive rate)                     |
| `npm run memory -- list\|export --project <id>`                                        | Project memory records (`show\|remove <id> --project <id>` for one record)             |
| `npm run memory -- check \| reindex`                                                   | Live embedder round trip; rebuild the index from the canonical SQLite records          |
| `npm run eval:memory [-- --repeat N]`                                                  | Memory A/B on the frozen `evals/memory/` pairs (needs Ollama; `verify`, `freeze`)      |
| `npm run verify-hidden [-- <taskId>]`                                                  | Hidden tests fail on baseline and pass on reference patches                            |
| `npm run eval:rescore -- <evalId>`                                                     | Re-judge a finished eval with the current hidden tests (stored diffs, no agents, $0)   |
| `npm run baseline:update -- --reason "…"`                                              | Move the `factory-baseline` tag to `main` (recorded in the DB)                         |
| `npm run reopen-merge -- <runId>`                                                      | One-time: put a pre-merge-gate success run at the merge gate                           |
| `npm run db:import`                                                                    | Import Week 1 run reports from `runs/` into the database                               |

### Runtime configuration (`factory.config.ts`)

```ts
roles: {
  planner:   { runtime: "claude-code", model: "opus" },
  developer: { runtime: "claude-code", model: "opus" },
  reviewer:  { runtime: "claude-code", model: "opus" },   // OpenCode reviewer disabled
  // to re-enable: { runtime: "opencode", model: "openai/gpt-6.1-sol", keyEnv: ["OPENAI_API_KEY"] }
},
reviewEval: { reviewers: [{ runtime: "claude-code", model: "opus" }] },
secretEnv: ["OPENAI_API_KEY", /* … */],   // never passed to Claude Code or the sandbox
evalCostCapUsd: 10,                       // shared by all repeats of one eval
```

The config is validated with Zod at load time: OpenCode can only take read-only roles, its
model must be an exact `provider/model` (no `latest`) different from the developer's, and
every `keyEnv` must also be listed in `secretEnv`.

## Latest metrics

Cycle-budget correction, `eval-20261017-095351`: TaskFlow, 10 tasks × 3 repeats, every role
Claude Code Opus 5.5, 2026-10-17. Mean ± sample stdev. Details:
[docs/cycles-budget-results.md](docs/cycles-budget-results.md).

| Metric                       | After the correction (3 repeats)        | Week 2, Opus reviewer (1 run) |
| ---------------------------- | --------------------------------------- | ----------------------------- |
| First-pass rate              | 96.3% ± 6.4% (denominator 9 per repeat) | 100% (9/9)                    |
| Verified rate                | 96.7% ± 5.8%                            | 100% (10/10)                  |
| False success rate           | 0% ± 0%                                 | 0% (0/9)                      |
| Avg gate fix / review cycles | 0.00 / 0.00                             | 0 (total only)                |
| Stopped by the review limit  | 0 of 27                                 | —                             |
| infra_error                  | 1 attempt, replaced by `--resume`       | — (recorded as `error`)       |
| Cost per repeat              | $5.98 ± $0.38                           | $5.82                         |

The only incorrect outcome (r2 `due-date`, `timeout`) was a provider outage: the reviewer's log
has only `api_retry` events and no model output. The measured code (`bb50b61`) counted it as
`timeout`; since `421b588` such a timeout is classified as `infra_error`. The metrics above
were not recomputed. The review limit never engaged, so `max_review_cycles` stays 1. The
Sol-vs-Opus reviewer comparison from Week 2 is in [docs/week2-results.md](docs/week2-results.md).

## GitHub interface (`npm run factory:watch`)

The main way to work with the factory: a task is an issue, decisions are comments, the result
is a pull request. The factory only polls GitHub from the owner's computer: no webhooks, no
public server.

1. Create an issue from the **Factory task** template (`.github/ISSUE_TEMPLATE/factory-task.yml`
   in the project), label `factory`.
2. The factory posts the specification as a comment: version, hash, requirements with their
   `source`, and the requirements outside the acceptance criteria. Reply `/approve` or
   `/reject <reason>`. An approval counts only for the latest version and only if written
   after it was published.
3. The factory opens a PR (`Closes #N`) with the spec, the spec and code diffs, every gate
   command and its result, the review verdict per cycle, cycles, cost and active time.
4. On the PR, comment `/merge` (the gate runs again on the merge result with the current
   target branch; only then is it pushed) or `/close <reason>`.
5. After `needs_clarification` or a failure: answer in the issue or edit it, then `/retry`.

| Label                         | Meaning                                                              |
| ----------------------------- | -------------------------------------------------------------------- |
| `factory`                     | a task for the factory (from an allowed user)                        |
| `factory:in-progress`         | planning or development is running                                   |
| `factory:spec-review`         | a specification waits for `/approve` or `/reject`                    |
| `factory:pr-open`             | the PR waits for `/merge` or `/close`                                |
| `factory:needs-clarification` | the planner's questions are in the issue; answer, then `/retry`      |
| `factory:failed`              | gate_failed, review_rejected, budget_exceeded, error, timeout        |
| `factory:paused`              | infra_error (provider or host unavailable); `/retry` when it is back |
| `factory:done`                | merged or closed                                                     |

**Trust rules.** GitHub is untrusted input.

- Issues and commands count only from `allowed_users` in `projects.yaml`. Everyone else is
  ignored and logged without their text, and nothing they write reaches an agent.
- Comments the factory writes carry `<!-- factory:bot -->` and are never commands. A command
  must start the first line of a comment.
- Every comment id is decided exactly once (`github_events`), so a restart, a crash or an edit
  never executes a command twice.
- Issue text and `/reject` reasons reach agents only inside a delimited
  `<untrusted_issue_data>` block.
- The CLI (`approve`, `reject`, `merge`, `close`) still works as the backup path: decisions are
  recorded with `channel = cli`, and the watcher publishes their result on GitHub.

**Setup.**

- A fine-grained token with access to the project repositories only (Issues, Pull requests,
  Contents: read and write), stored as `FACTORY_GITHUB_TOKEN` in `.env`. Only the factory's own
  `gh` and `git` processes get it, as `GH_TOKEN` with an empty factory-owned `GH_CONFIG_DIR`
  (no `gh auth login`, no keyring). Agents and the sandbox never see it, and it is masked
  everywhere.
- In `projects.yaml`, a project gets `github: { repo: owner/name }`, `allowed_users`, and a
  git `source` whose `ref` is the target branch. The labels are created on the first poll.
- **Protect the target branch.** Block force-pushes and deletion. The factory pushes the gated
  merge result directly to the target branch, never forced. A rule "require a pull request
  before merging" would reject that push unless the token's owner may bypass it. Either allow
  that bypass, or protect only against force-push and deletion. A PR merged by hand on GitHub
  is recorded as `merged_externally`, because no merge gate ran.

## Dashboard (`npm run dashboard`)

A read-only web view of the database, at `http://127.0.0.1:4317/` (`--port` to change). It
listens on 127.0.0.1 only; there is no option for another address.

- **Runs** of every project, most recent first, filtered by project and status, with links to
  the GitHub issue and PR.
- **A run**: spec (or the spec waiting for approval), diff, gate checks, review verdict and
  issues, steps, the event feed, and approvals with their channel (`github`, `cli`, `auto`).
- **Evals** with their metrics and tasks, and a comparison of two evals. Two evals are
  compared only when they ran on the same baseline commit of the same project.

Read-only by construction: GET routes only (a test checks there is no POST, PUT, PATCH or
DELETE route), and the database connection is opened with `query_only`. Pages are rendered on
the server without scripts (CSP `default-src 'none'`); every value is HTML-escaped. Each page
passes the secret redactor (configured secret values, token and key shapes). Requests for
another `Host` are refused (no DNS rebinding). Files are read only from `runs/`.

## Project memory (optional)

The factory works without memory; it is **off by default** (`memory.enabled: false` in
`factory.config.ts`). When it is on, the planner of a run gets up to `memory.limit` records of
that project, each with its source, and the report and PR list which records were used.

What is stored, and only once it is confirmed:

- `spec_rejection_comment`: a rule the planner generalized from a human `/reject` comment (an
  allowed user, never the factory), stored when the revised spec is approved;
- `review_issue_fixed`: a reviewer finding whose fix then passed the gate and the review;
- `merged_run`: an `existing_behavior` requirement of a merged spec;
- `manual`: a human entry.

Never stored: hidden tests or anything about them, reference patches, raw logs, diffs,
secrets (token and key shapes, configured secret values), text of users who are not allowed.
Every record is at most 500 characters.

**Storage.** The canonical record (text, source, run, time, project, embedder) is in the SQLite
`memories` table. The vector index is Mem0 OSS (`mem0ai` 3.3.1) with `infer: false` (Mem0's LLM
is never called), its SQLite vector store in `data/memory/` (git-ignored), and a local Ollama
embedder. No key, nothing leaves the machine.

**Install Ollama** (only if you turn memory on):

```bash
brew install ollama
brew services start ollama      # listens on 127.0.0.1:11434; do not change OLLAMA_HOST
ollama pull nomic-embed-text:latest
npm run memory -- check         # live round trip: embed, store, search, delete
```

The config pins the model with its tag and digest (`nomic-embed-text:latest`, `0a109f422b47`)
and every record names it (`ollama/nomic-embed-text:latest@0a109f422b47`). The URL must be
`http://127.0.0.1:<port>`. If the tag moves to another digest, or the config names another
model, the factory refuses to start on the old index and says to run
`npm run memory -- reindex`, which rebuilds it from the canonical records.

**When Ollama is not running:** ordinary runs go on without memory, and the report and the PR
say "Memory unavailable". `npm run eval:memory` stops with `infra_error` instead, because
`memory_on` must not silently become `memory_off`. `npm run check` never needs Ollama.

## Security model

### Checks run in a sandbox (`src/quality/sandbox.ts`, `sandbox/<profile>/`)

Typecheck and tests are executed by the factory, never trusted from the agent, inside a
Docker container with:

- `--network none` — no network at all during checks;
- no host environment variables (only `HOME=/tmp`, `CI=1`, `NO_COLOR=1`, `FORCE_COLOR=0`);
- read-only root filesystem, non-root user (uid 1000), `--cap-drop ALL`,
  `no-new-privileges`, memory / CPU / PID limits;
- the worktree bind-mounted **read-only** at `/src` and copied into an in-memory `/work`;
  checks can never modify the worktree;
- one image per sandbox profile (`sandbox/node22/`, `sandbox/python312/`: a Dockerfile with
  the base image pinned by digest, and a bootstrap script). Dependencies are preinstalled at
  image build time from the project's `profile.dependency_files` (`/deps`, read-only). The
  image tag is a hash of the profile and those files, so a lockfile change produces a new
  image. The build context contains only those files — no source code, secrets, or host
  dependency directories.
- every run has a timeout; on timeout the container is killed (`docker kill`).

The image build itself needs network (base image pull, `npm ci`). Checks never do.

### OpenCode reviewer (`src/runtimes/opencode.ts`) — implemented, currently disabled

- Read-only roles only: the runtime refuses the developer role, and `OPENCODE_PERMISSION`
  denies every tool except `read`, `grep`, `glob`, `list` (and `external_directory`). Without
  `--auto`, `opencode run` rejects every permission request instead of waiting.
- Isolation from the user's setup: `--pure`, no project config, no `~/.claude` prompts or
  skills, no plugins, no sharing, no auto-update.
- The child environment is built explicitly (base variables + the role's `keyEnv`); provider
  keys are never given to Claude Code (`agentEnv` allow-list) or to the check sandbox, and are
  masked in logs and in the database.
- Verified live (2026-10-16): write/bash tools are not offered, and a read outside the
  worktree is denied.

### Pi runtime (`src/runtimes/pi.ts`) — Pi reviewer on a local Ollama model, ready, not default

Third runtime, for read-only roles. Owner's decision: a **reviewer on a local model through
Ollama** (127.0.0.1), never with the Claude subscription. Opus stays the default reviewer;
`factory.config.ts` switches with one line (`reviewer: PI_OLLAMA_REVIEWER`). Setup (the model
is pulled by hand), model choice for 16 GB, and the 70% recall rule before an eval:
[docs/pi-runtime.md](docs/pi-runtime.md).

```bash
ollama pull qwen2.5-coder:7b-instruct-q4_K_M
ollama create factory-reviewer-qwen2.5-coder-7b -f ollama/factory-reviewer-qwen2.5-coder-7b.Modelfile
npm run eval:review        # Opus vs Pi: recall, false positive rate, time; prints the Pi gate
```

- Before every review the factory checks the pinned digest, the derived model and its
  `num_ctx` on 127.0.0.1; the answer is constrained to the reviewer's JSON Schema
  (`response_format`, no tools), with the reviewers' single retry.

- Pi has no path confinement of its own: the factory's extension `pi-guard.ts` blocks every
  tool call except read/grep/find/ls inside the worktree, and secret files (`.env*`, `*.pem`,
  `*.key`). A test runs the real Pi binary against a fake provider on 127.0.0.1 and checks
  that reads outside the worktree, of `.env`, through a symlink, and `bash` never run.
- Isolation: explicit env (base variables + the role's `keyEnv`), a factory-owned agent dir
  (`<FACTORY_WORKDIR>/pi-agent`, with `HOME` inside it), no sessions, extensions, skills,
  context files or project trust, `PI_OFFLINE=1`, `PI_TELEMETRY=0`.
- Pi exits 0 even when the provider refused the call; the outcome is read from its events,
  and provider refusals are `infra_error` by the shared patterns.

### Known limitation: the agent runs on the host (Weeks 1–2)

Claude Code needs access to the Anthropic API, so the agent process runs on
the host, with its working directory set to an isolated git worktree under
`FACTORY_WORKDIR` (outside this repository, so hidden tests and reference patches are not
reachable by relative paths). It is constrained by Claude Code's own permission system
(`src/runtimes/claude-code.ts`, `src/runtimes/tool-policy.ts`; behavior verified with live
probes against Claude Code 2.1.300):

- Planner and Reviewer: only `Read`, `Grep`, `Glob`, `--permission-mode dontAsk`.
- Developer: `Read`, `Grep`, `Glob`, `Edit`, `Write` plus exact `Bash(...)` commands
  (`npm run check`, `npm test`, `git status`, `git diff`, ...), `--permission-mode acceptEdits`.
  No bare `Bash`, no wildcard Bash rules (`git diff *` would admit `--output=<outside path>`).
- `--permission-prompts none`: anything that would need approval is denied, never waits.
- No bare allow rules for file tools: a bare `Read` allow rule permits reading **outside** the
  working directory (verified). Without allow rules, file access is confined to the worktree.
  Writes, `cat` of outside files, compound commands with non-allowed parts, and `curl` were
  all denied in probes. `.env*`, `*.pem`, `*.key` are explicitly denied even inside it.
- `--setting-sources ""`, `--strict-mcp-config`, `--disable-slash-commands`,
  `--no-session-persistence`: no user settings, no hooks or permission rules from the target
  repo's `.claude/`, no MCP servers. This also disables `CLAUDE.md` auto-loading, so the
  factory injects the target's `CLAUDE.md` into the system prompt itself (deterministic, and
  ancestor directories cannot leak instructions).
- Environment: only an allow-list of variables (`HOME`, `USER`, `PATH`, locale, ...) is passed;
  other host secrets are withheld. On timeout the agent's whole process group is killed.
- Denied tool calls are recorded (`permissionDenials`) in every run report.
- Observed in eval logs: Claude Code itself also auto-allows read-only shell commands
  inside the worktree (e.g. `cat src/x.ts && ls tests`, `npm run check | tail`), while a
  `python3` heredoc that rewrites a file was denied — the agent then used `Edit`.

This is weaker than the check sandbox: an allowed command such as `npm run check` executes
scripts from the worktree's `package.json` on the host, with network. The scope check in
the Quality Gate flags changes outside `allowed_paths` (e.g. `package.json`), but only
after the fact.

**Planned hardening:** run the agent itself in a container with the worktree mounted,
no host home directory or credentials beyond a scoped API token, and network egress
restricted to the Anthropic API endpoint (egress proxy / firewall allow-list).

## Requirements

- Node.js ≥ 22.13 (see `.nvmrc`)
- Git ≥ 2.40
- Docker (daemon running)
- Claude Code CLI (`claude`), authenticated
- `OPENAI_API_KEY` in `.env` only if the OpenCode reviewer is re-enabled (OpenCode itself is an
  npm dependency)
- Ollama with `nomic-embed-text:latest`, only if project memory is turned on (optional)
- Node.js ≥ 22.19 and Ollama with the pinned reviewer model, only if the Pi reviewer is used

## Development

```bash
npm ci
npm run check            # typecheck, lint, format, unit tests (no Docker, no network)
npm run test:sandbox     # Docker integration tests (first run builds the sandbox image)
npm run verify-hidden    # hidden tests fail on baseline and pass on reference patches
npm run smoke:claude     # live check of the Claude Code adapter (a few cents)
```
