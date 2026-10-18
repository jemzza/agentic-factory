# Enabling OpenAI (no code changes)

OpenAI is supported but **off**. The owner disabled it after the Week 2 budget ran out. Every
use goes through configuration only: `.env` for the key and `factory.config.ts` for the role.
Nothing in the code names a provider.

## What OpenAI can be used for

| Use                                    | Config                                                                                                           | Notes                                                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Reviewer through OpenCode (Week 2 Sol) | `reviewer: { runtime: "opencode", model: "openai/gpt-6.1-sol", keyEnv: ["OPENAI_API_KEY"] }`                     | Read-only adapter (`src/runtimes/opencode.ts`); Week 2: recall 100%, ≈ $0.04 per review                       |
| Reviewer or planner through Pi         | `{ runtime: "pi", model: "openai/<exact-model-id>", keyEnv: ["OPENAI_API_KEY"] }`                                | Read-only, with the guard extension ([pi-runtime.md](pi-runtime.md))                                          |
| Memory embedder                        | `memory.embedder: { provider: "openai", model: "text-embedding-3-small", dims: 1536, keyEnv: "OPENAI_API_KEY" }` | Memory texts go to OpenAI; then run `npm run memory -- reindex` (vectors of different models cannot be mixed) |

The developer stays Claude Code. OpenAI-backed runtimes are read-only, and the config
refuses them as the developer.

## Steps

1. **Key.** Create a dedicated OpenAI key with a spending limit and put it in `.env`
   (git-ignored):

   ```bash
   OPENAI_API_KEY=sk-...
   ```

   `OPENAI_API_KEY` is already in `secretEnv`. It is passed only to the OpenCode or Pi process
   that names it in `keyEnv`. Claude Code and the sandbox never get it, and it is masked in the
   database, logs and reports.

2. **Check the key.**

   ```bash
   npm run provider:check -- openai
   ```

   | Result                | Exit code | Meaning                                                 |
   | --------------------- | --------- | ------------------------------------------------------- |
   | `PASS`                | 0         | The key is accepted (`GET /v1/models`, no tokens spent) |
   | No key                | 2         | Clear message; nothing is called                        |
   | Rejected key          | 1         | The key is invalid or revoked                           |
   | Rate limit, 5xx, none | 3         | The provider is unavailable                             |

   The check does **not** see quota or billing. An exhausted budget shows up only on a model
   call, and the run then ends `infra_error`.

3. **Switch the role.** Change one line in `factory.config.ts`. The OpenCode line is already
   there as a comment. To compare first, add the binding to `reviewEval.reviewers`.

4. **Measure before relying on it.**

   ```bash
   npm run eval:review        # recall / false positive rate / time / cost vs Opus
   npm run eval               # one full eval against the Week 3 baseline
   ```

5. **To switch back,** revert the line; the key can stay in `.env` unused. After an embedder
   change in either direction, run `npm run memory -- reindex`.

## Where the data goes

- **A reviewer** sees the task, the approved spec, the diff and, through read-only tools,
  files of the worktree. All of that goes to OpenAI.
- **The embedder** sees memory texts: short project rules. Hidden tests, reference patches,
  logs, diffs and secrets are refused before anything is stored.
