# Adding a project to the factory

The factory knows no project in its code. A project is a git repository with its own rules in
`.factory/config.yaml`, and one entry in this repository's `projects.yaml`.

## 1. The repository

Commit these files to the project's target branch:

- `.factory/config.yaml`: how the factory works in this repository. The factory reads it with
  `git show` from the target branch as committed, never from an agent's worktree, and freezes
  it in the run state. Examples: `fixtures/taskflow/.factory/config.yaml` (Node 22) and the
  ledgerlite repository (Python 3.12).

  ```yaml
  version: 1
  profile:
    image: node22 # a directory sandbox/<image>/ in the factory repository
    dependency_files: [package.json, package-lock.json]
    host_deps_dir: node_modules
    install: npm ci --no-audit --no-fund
    checks: # the gate: every check must exit 0, in the sandbox, without network
      - { name: typecheck, run: npm run typecheck }
      - { name: test, run: npm test }
    agent_commands: [npm run check, npm test] # what the developer agent may run
    self_check: npm run check
  conventions_file: CLAUDE.md # given to every agent
  scope:
    allowed_paths: ["src/**", "tests/**"]
    protected_paths: [".factory/**", ".github/**", "CLAUDE.md"]
  budget_defaults:
    { max_gate_fix_cycles: 2, max_review_cycles: 1, max_cost_usd: 1.0, timeout_minutes: 15 }
  target_branch: main
  ```

- The conventions file (`CLAUDE.md`): the project's rules for agents.
- A sandbox profile, if no existing one fits: `sandbox/<image>/Dockerfile` and `bootstrap.sh`
  in the factory repository, with the exact language version pinned.

## 2. The registry

Add the project to `projects.yaml`:

```yaml
- id: my-project
  source: { kind: git, url: https://github.com/<owner>/my-project.git, ref: main }
  github: { repo: <owner>/my-project } # only for factory:watch
  allowed_users: [<owner>] # only these GitHub users can give tasks and commands
```

For GitHub, the fine-grained token in `FACTORY_GITHUB_TOKEN` must include the new repository
(see the README, "GitHub interface").

## 3. Check it

```bash
npm run project:check -- my-project
```

This validates the config, builds the sandbox image, runs the install and every gate check on
a clean target branch. No agents run.

## 4. Project memory (optional)

The factory works fully without memory, and it is off by default. When it is on
(`memory.enabled: true` in `factory.config.ts`), each project has its own memory: records of
one project are never shown to another project's runs.

Memory needs a local Ollama with the pinned embedding model:

```bash
brew install ollama
brew services start ollama      # 127.0.0.1:11434; leave OLLAMA_HOST unset
ollama pull nomic-embed-text:latest
ollama cp nomic-embed-text:latest nomic-embed-text:0a109f422b47   # pinned by ID (check `ollama list`)
npm run memory -- check
```

Nothing to set up per project. Records appear as the project's runs are approved, reviewed and
merged (`npm run memory -- list --project my-project` shows them, `remove` deletes one).
If Ollama is stopped, runs go on without memory and their report and PR say so. If the model
changes, run `npm run memory -- reindex`.
