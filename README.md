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
reachable by relative paths). It is constrained by Claude Code's own permission system:

- Planner and Reviewer: read-only tools only (`Read`, `Grep`, `Glob`).
- Developer: file edit tools plus an allow-list of specific `Bash` commands
  (`npm run check`, `npm test`, `git status`, `git diff`); everything else is denied
  (`--permission-mode dontAsk`). No `bypassPermissions` anywhere.
- User/project settings and MCP servers are not loaded (`--setting-sources ""`,
  `--strict-mcp-config`).

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
```
