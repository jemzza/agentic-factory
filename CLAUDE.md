# Agentic Software Factory — project rules

This file governs work on the **factory itself**. Agents working on a target
repository read that repository's own `CLAUDE.md`, not this one.

## Before you finish

- Run `npm run check` (typecheck + lint + format check + tests) and make sure it exits 0.
  Do not report work as done if it was not run or did not pass; paste the failing output instead.

## Hard rules

- **Never commit secrets.** No API keys, tokens, `.env` files, or credentials in code, tests,
  fixtures, prompts, or run logs. Configuration that needs secrets reads them from the environment.
  `.env` is git-ignored; document new variables in `.env.example` with placeholder values only.
- **Never modify `evals/hidden/` or `evals/reference/`** to make metrics look better: no weakening,
  skipping, or deleting hidden tests. Changing them requires an explicit request from a human,
  and the change must be called out in the commit message.
- Hidden tests and reference patches must never be copied into, or be reachable from, an agent's
  worktree. Agent worktrees and target-repo clones live under `FACTORY_WORKDIR`, outside this repo.
- Do not use `--dangerously-skip-permissions` / `bypassPermissions` anywhere.
- Never give agents access to `.env`, the home directory, or paths outside their worktree.

## Principles

- **Facts over agent claims.** Success is decided by external command exit codes and hidden tests,
  never by what an agent says.
- **Validate at boundaries.** Every input/output that crosses a process or file boundary (task
  definitions, agent responses, reports, config) is parsed with Zod. An invalid agent response is
  a step error, not something to repair heuristically.
- **Everything is bounded.** Every subprocess has a timeout; fix cycles and cost are capped.
- **Don't guess CLI flags.** Check `--help` before using a flag of `claude`, `docker`, or `git`,
  and document the expected output format next to the code that parses it.
- **Keep it simple.** No queues, parallel task execution, or UI until explicitly planned.
  Orchestration is LangGraph (Week 2); the graph routes, existing modules do the work.
- **The database is the source of truth** for runs (`data/factory.db`, SQLite). `report.json` /
  `report.md` are derived artifacts. Schema changes are new files in `migrations/`; never edit
  an applied migration. Secret values are masked before anything is written to the DB.

## Code style

- TypeScript strict mode, ESM, Node ≥ 22.13. Relative imports use the `.js` extension.
- Prefer small pure functions; isolate side effects (processes, filesystem, git, docker) behind
  narrow modules so they can be faked in tests.
- Model outcomes as discriminated unions (`{ kind: ... }`) and handle them exhaustively;
  expected failures (timeout, non-zero exit, invalid output) are values, not thrown exceptions.
- Use `import type` for type-only imports. No `any`; use `unknown` and narrow with Zod.
- Formatting is owned by Prettier; lint rules by ESLint (`typescript-eslint` strict type-checked).
- Tests live next to the code as `*.test.ts` (Vitest). Tests must not call the real Claude API
  or require network; use fake processes.
- Commit after each coherent step with a descriptive message.

## Layout

- `src/` — factory code (`cli.ts`, `schemas/`, `runtimes/`, `agents/`, `pipeline/`, `git/`,
  `quality/`, `eval/`, `report/`).
- `prompts/` — role system prompts.
- `fixtures/<target>/` — source of benchmark target repositories (materialized into
  `FACTORY_WORKDIR` as real git repos by setup).
- `evals/tasks/<id>/task.yaml` — visible task definitions.
- `evals/hidden/<id>/` — hidden acceptance tests (never shown to agents).
- `evals/reference/<id>.patch` — reference implementations used only to validate hidden tests.
- `sandbox/` — Docker image for running checks with `--network none`.
- `src/store/` — SQLite access (migrations runner, `Store`, secret redaction, report import).
- `migrations/` — numbered SQL migrations (`NNN_name.sql`).
- `data/` — the factory database (git-ignored).
- `docs/` — design documents (`graph.md`, `week2-design.md`).
- `runs/` — run outputs (git-ignored).
