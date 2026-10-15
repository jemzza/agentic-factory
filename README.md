# Agentic Software Factory

Takes a development task against a target repository and drives it to a **verified** result:

1. **Planner** — explores the code read-only and produces a structured plan (or asks questions).
2. **Developer** — implements the plan in an isolated git worktree.
3. **Quality Gate** — typecheck and tests run by the factory (not the agent) in a Docker
   sandbox with `--network none`, plus a scope check of the diff.
4. **Reviewer** — independent read-only review of the diff against acceptance criteria.
5. **Report** — diff, actual command output, verdict, time and cost.

A human always does the merge.

> Status: Week 1 (MVP loop) in progress. Architecture, security limitations, and metrics
> will be documented here as phases land.

## Requirements

- Node.js ≥ 22.13 (see `.nvmrc`)
- Git ≥ 2.40
- Docker (daemon running)
- Claude Code CLI (`claude`), authenticated

## Development

```bash
npm ci
npm run check
```
