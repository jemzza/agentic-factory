# Agentic Software Factory

Takes a development task against a target repository and drives it to a **verified** result:

1. **Planner** — explores the code read-only and produces a structured plan (or asks questions).
2. **Developer** — implements the plan in an isolated git worktree.
3. **Quality Gate** — typecheck and tests run by the factory (not the agent) in a Docker
   sandbox with `--network none`, plus a scope check of the diff.
4. **Reviewer** — independent read-only review of the diff against acceptance criteria.
5. **Report** — diff, actual command output, verdict, time and cost.

A human always does the merge.

> Status: Week 1 — one reliable, measurable loop with Claude Code as the only runtime.
> LangGraph, OpenSpec, Mem0, OpenCode and Pi are planned for later weeks; the
> `AgentRuntime` interface and the per-target config are the extension points.

## Architecture

```
npm run run-task -- <id>          npm run eval
        │                               │  (sequential, all tasks or a subset)
        ▼                               ▼
  pipeline/run-task.ts  ◄──────── eval/run-eval.ts ──► hidden tests on a COPY of the
        │                               │               final worktree (sandbox)
        │                               ▼
        │                         runs/eval-<ts>/summary.{md,json}
        ▼
 1 prepare   git/target-repo.ts   target repo under $FACTORY_WORKDIR/repos (outside this repo)
             git/worktree.ts      worktree on branch factory/<task>-<run>; hidden-artifact guard
 2 planner   agents/planner.ts    read-only; Zod { plan, files_to_change, risks, questions }
             questions ≠ []  ──►  needs_clarification
 3 developer agents/developer.ts  edits + exact Bash allow-list; snapshot commit after each cycle
 4 gate      quality/gate.ts      scope (git diff ⊆ allowed_paths, non-empty) +
             quality/sandbox.ts   typecheck, test in Docker --network none
 5 reviewer  agents/reviewer.ts   read-only; sees task + criteria + diff only;
                                  Zod { verdict, issues, criteria_check }
 6 fix loop  ≤ max_fix_cycles (2) with gate output / review findings
 7 report    report/markdown.ts   runs/<run>/report.{json,md} + raw agent & check logs
```

- `runtimes/types.ts` — `AgentRuntime` contract; `runtimes/claude-code.ts` — headless
  Claude Code adapter (`claude -p --output-format stream-json`), `runtimes/tool-policy.ts` —
  per-role tool policy enforced in code.
- `schemas/` — Zod schemas at every boundary: task specs, eval metadata, config, agent
  answers, step results, run reports, eval summaries. An agent answer that does not match
  its schema is a step error (`invalid_response`), never repaired.
- `prompts/` — role system prompts; the target's `CLAUDE.md` is appended by the factory.
- `fixtures/taskflow/` — the first target (Fastify + TypeScript service), materialized as a
  real git repository by the factory.
- `evals/tasks/` (visible) · `evals/hidden/` (hidden tests + eval metadata) ·
  `evals/reference/` (reference patches) — the last two are never reachable from agents.

### Statuses and limits

`success` · `gate_failed` · `review_rejected` · `needs_clarification` · `timeout` ·
`budget_exceeded` · `error`. Every step has a timeout capped by the task deadline
(`timeout_minutes`); each agent call gets only the remaining budget and the run stops
hard once `max_cost_usd` is exceeded; at most 2 fix cycles. A run is `success` only if
the sandboxed checks exit 0 and the reviewer's structured verdict approves with every
criterion met — the developer's own claims are never evidence. In eval, a `success` is
then checked by hidden tests: `verified` or `false_success`.

## How to run

```bash
npm ci
cp .env.example .env          # optional: CLAUDE_BIN, FACTORY_WORKDIR
claude auth status            # the agent CLI must be logged in
npm run run-task -- complete-task      # one task → runs/<runId>/report.md
npm run eval                           # all 10 tasks → runs/eval-<ts>/summary.md
npm run eval -- pagination due-date    # a subset
```

Configuration lives in `factory.config.json` (target repo, checks, per-role models, step
timeouts). Successful runs leave their branch in the worktree for a human to review and
merge; the factory never merges.

## Latest metrics

`npm run eval` on 2026-10-15 (`eval-20261015-130103`), Claude Code 2.1.300, Opus for all roles,
TaskFlow target, 10 tasks run sequentially.

| Metric                                     | Value                       |
| ------------------------------------------ | --------------------------- |
| Verified rate (correct / total)            | **100%** (10/10)            |
| False success rate                         | **0%** (0/9 success claims) |
| Average fix cycles                         | 0                           |
| Average time per task                      | 146.2s                      |
| Total cost (list-price estimate)           | $5.28                       |
| Hidden-test files found in agent worktrees | 0                           |

| Task             | Difficulty | Outcome             | Hidden tests | Fix cycles | Time | Cost   |
| ---------------- | ---------- | ------------------- | ------------ | ---------- | ---- | ------ |
| `bulk-status`    | medium     | verified            | 11/11        | 0          | 104s | $0.496 |
| `complete-task`  | simple     | verified            | 4/4          | 0          | 79s  | $0.398 |
| `due-date`       | medium     | verified            | 20/20        | 0          | 157s | $0.809 |
| `hard-delete`    | simple     | needs_clarification | —            | 0          | 15s  | $0.051 |
| `pagination`     | hard       | verified            | 19/19        | 0          | 187s | $0.868 |
| `reopen-task`    | simple     | verified            | 5/5          | 0          | 73s  | $0.379 |
| `restore-task`   | medium     | verified            | 6/6          | 0          | 476s | $0.418 |
| `search-tasks`   | simple     | verified            | 8/8          | 0          | 112s | $0.600 |
| `sort-tasks`     | medium     | verified            | 10/10        | 0          | 117s | $0.554 |
| `status-history` | hard       | verified            | 9/9          | 0          | 137s | $0.708 |

**How to read this.** This is a single run, so run-to-run variance is not measured yet.
Every implementable task passed the gate and review on the first attempt (0 fix cycles),
and the contradictory `hard-delete` stopped with `needs_clarification`. The result means
the suite is close to saturated for Opus: the fix-cycle path and `false_success` detection
were exercised only by unit tests (fake runtime) and by the reference/mutation checks of the
hidden tests, not by a real failing agent. Next steps: harder tasks, a cheaper model
(e.g. `sonnet` via `factory.config.json`) to calibrate, and repeated runs to measure variance.
The slowest task (`restore-task`, ~8 min) spent most of its time in API retries
(`api_retry` events in the agent log), not in the pipeline.

## Security model

### Checks run in a sandbox (`src/quality/sandbox.ts`, `sandbox/Dockerfile`)

Typecheck and tests are executed by the factory, never trusted from the agent, inside a
Docker container with:

- `--network none` — no network at all during checks;
- no host environment variables (only `HOME=/tmp`, `CI=1`, `NO_COLOR=1`, `FORCE_COLOR=0`);
- read-only root filesystem, non-root user (uid 1000), `--cap-drop ALL`,
  `no-new-privileges`, memory / CPU / PID limits;
- the worktree bind-mounted **read-only** at `/src` and copied into an in-memory `/work`;
  checks can never modify the worktree;
- dependencies preinstalled at image build time from the target's `package-lock.json`
  (`/deps/node_modules`, read-only). The image tag is a hash of the Dockerfile and the
  dependency manifests, so a lockfile change produces a new image. The build context
  contains only those files — no source code, secrets, or host `node_modules`.
- every run has a timeout; on timeout the container is killed (`docker kill`).

The image build itself needs network (base image pull, `npm ci`). Checks never do.

### Known limitation: the agent runs on the host (Week 1)

Claude Code needs access to the Anthropic API, so in Week 1 the agent process runs on
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

## Development

```bash
npm ci
npm run check            # typecheck, lint, format, unit tests (no Docker, no network)
npm run test:sandbox     # Docker integration tests (first run builds the sandbox image)
npm run verify-hidden    # hidden tests fail on baseline and pass on reference patches
npm run smoke:claude     # live check of the Claude Code adapter (a few cents)
```
