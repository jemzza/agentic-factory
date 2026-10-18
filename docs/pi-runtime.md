# Pi as the third runtime

Week 3 Phase 7. Pi is an open-source coding agent CLI (`@earendil-works/pi-coding-agent`,
formerly `@mariozechner/pi-coding-agent`, deprecated at 0.73.1). The factory pins **1.0.2**
(exact, published 2026-10-04; 1.3.0 is the latest at the time of writing). Pi needs
Node ≥ 22.19; the factory runs on 22.23.3.

**Owner's decision (2026-10-18): Pi is a reviewer on a local model through Ollama
(127.0.0.1:11434).** The Claude subscription is never connected to Pi, and the config refuses
it (any `anthropic/` or Claude model, and any `ANTHROPIC_*` or `CLAUDE_*` key). The main
reviewer for Phase 8 stays Opus. Switching is the owner's call, made by the numbers.
`factory.config.ts` has the ready binding `PI_OLLAMA_REVIEWER`, so the switch is one line
(a demo step).

## What was checked

Sources: `pi --help` and the package's own `docs/` (json.md, providers.md, security.md,
extensions.md, models.md) of 1.0.2, plus live runs of the real Pi binary against a fake
OpenAI-compatible provider on 127.0.0.1. No real provider was called, and no money was spent.

| Question                  | Answer                                                                                                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Non-interactive mode      | `pi --mode json -p`: JSONL on stdout, a `session` header and then session events. With `-p` the prompt is read from stdin when stdin is a pipe. Diagnostics go to stderr.                                                             |
| Final answer              | The last assistant `message_end.message` with `stopReason: "stop"`. No schema-constrained output, so the factory takes the last JSON object of the text and validates it with Zod, as for OpenCode.                                   |
| Cost and tokens           | Yes, on every assistant `message_end`: `usage {input, output, cacheRead, cacheWrite, totalTokens, cost: {…, total}}`, USD per message. The factory sums them; input includes cache reads and writes.                                  |
| Provider and model choice | `--model <provider>/<id>` (or `--provider`). Providers: API keys from env vars, OAuth subscriptions via `/login` (stored in `auth.json` of the agent dir), and any OpenAI/Anthropic/Google-compatible endpoint in `models.json`.      |
| Tool restriction          | `--tools read,grep,find,ls` is an allowlist (built-in, extension and custom tools). Asked for `bash`, Pi answers "Tool bash not found".                                                                                               |
| Working directory         | The process cwd. **It does not confine anything**: Pi's `read` reads any file the process can read (security.md says so).                                                                                                             |
| Provider errors           | Retried 3 times (`auto_retry_start`), then `auto_retry_end {success:false, finalError}`. A 429 was seen live as `"429: {…}"`. **The process still exits 0**, so the factory judges the outcome by the events, never by the exit code. |
| Spend cap                 | No flag. The step timeout bounds a run. A cost above the step's budget is reported as a `budget` error after the run ends.                                                                                                            |

## What was built (read-only roles: planner, reviewer)

- `PiRuntime` (`src/runtimes/pi.ts`) implements `AgentRuntime`. The role and model come only
  from `factory.config.ts`: `{ runtime: "pi", model: "<provider>/<exact-id>", keyEnv: [...] }`.
  The config refuses Pi as the developer, a model without a provider, `latest` aliases, a
  reviewer on the developer's model, and a `keyEnv` that is not in `secretEnv`.
- **Guard extension** (`src/runtimes/pi-guard.ts`), loaded with `--no-extensions -e`. It is the
  path boundary Pi lacks. It allows only read, grep, find and ls, and blocks any path that
  resolves outside the worktree (symlinks followed, `~` refused). It also blocks secret files
  (`.env*`, `*.pem`, `*.key`) and grep/find patterns that could reach outside the worktree.
  Blocked calls are reported as permission denials.
- **Isolation.**
  - The child gets an explicit env: `PATH`, locale, the role's keys only.
  - Pi uses a factory-owned agent dir, `<FACTORY_WORKDIR>/pi-agent`, with `HOME` inside it. The
    user's `~/.pi` is never read.
  - Flags: `--no-session --no-skills --no-prompt-templates --no-themes --no-context-files
--no-approve`. Conventions come from the factory, read with `git show`, not from the
    worktree's `CLAUDE.md`.
  - Environment: `PI_OFFLINE=1` (no catalog or update calls at startup) and `PI_TELEMETRY=0`.
  - Keys are masked in every log the factory writes.
- **Errors.** Provider refusals are classified with the shared patterns in
  `provider-errors.ts`: 429, 5xx, overload, rate or usage limit, "Connection error", and
  network errno codes. They become `infra`, so the run ends `infra_error`. A timeout during
  which Pi only retried is also `infra`. A 4xx request error is a `process` error.
- **Tests.**
  - The adapter runs on a fake `pi` process: timeout, non-zero exit, invalid output, missing
    JSON, cut-off answer, overspend, `infra_error`, and parsing of cost and tokens from two
    recorded streams.
  - One test runs the **real Pi binary** against a fake provider on 127.0.0.1. The model asks
    for `/etc/hosts`, `.env`, `bash`, a symlink to a file outside the worktree, and a file
    inside it. Only the last one ran, and the provider never received the content of the
    others.

**Not built: Pi as the developer.** It would need three more things:

- a guard that allows `bash` only for the project's exact commands;
- keeping the provider key out of the environment of those commands, which run agent-written
  code;
- confining `edit` and `write`.

Claude Code gets the first two from its own permission rules and subscription login. If the
owner wants Pi as the developer, that is a separate step.

## The local reviewer model

The Mac is a MacBook Pro M1 Pro with 16 GB of unified memory (`sysctl hw.memsize` =
17179869184). By default macOS gives the GPU about two thirds of that, roughly 10.7 GB. Claude
Code, Docker and the Ollama embedder also need memory. So the model, plus its KV cache at a
32K context, should stay under about 8 GB.

| Model (Ollama tag, pinned)                                              | Size   | With a 32K KV cache | Expected speed on M1 Pro (estimate)                                             | Why                                                                                     |
| ----------------------------------------------------------------------- | ------ | ------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **`qwen2.5-coder:7b-instruct-q4_K_M`**, digest `dae161e27b0e` (default) | 4.7 GB | ≈ 6.5 GB            | ~25–30 tokens/s output, a few hundred tokens/s prompt; ≈ 0.5–1.5 min per review | Code-specialised, no thinking phase (fast, predictable), good at JSON; fits with margin |
| `qwen3.5:9b-q4_K_M`, digest `56671c2ab938` (alternative)                | 6.6 GB | ≈ 8–9 GB            | ~15–20 tokens/s, slower with its thinking phase; ≈ 1.5–3 min per review         | Newer general model with tools and thinking, 256K context; tighter on 16 GB             |

The digests come from the ollama.com tag pages. After a pull, `ollama list` shows the real
digest, and the factory refuses a mismatch. The speeds are estimates; the real time per review
is measured in the final block. `qwen2.5-coder:14b` (9.0 GB) and larger models do not fit
16 GB with a usable context.

**Commands (the owner runs them):**

```bash
ollama pull qwen2.5-coder:7b-instruct-q4_K_M
ollama create factory-reviewer-qwen2.5-coder-7b -f ollama/factory-reviewer-qwen2.5-coder-7b.Modelfile
```

The derived model only sets `num_ctx 32768` and `temperature 0`. It exists because Ollama's
OpenAI-compatible `/v1` cannot set the context size per request; without it, a review prompt
would be cut off silently at the default context. For the alternative model, use
`ollama/factory-reviewer-qwen3.5-9b.Modelfile` and its pin.

**Before every review** the factory checks Ollama on 127.0.0.1 (`src/runtimes/pi-ollama.ts`):

- the base tag is present with the pinned digest;
- the derived model exists, is built from the same weights, and has the configured `num_ctx`.

If Ollama is unreachable, the review fails as `infra_error`. If the model is missing or
different, the step fails with the exact `ollama pull` / `ollama create` command. The factory
writes the `ollama` provider into its own Pi agent dir (`models.json`, cost $0).

**Structured output.** Pi has no schema flag. Ollama's `/v1` accepts
`response_format: {type: "json_schema"}`, so the factory's Pi extension adds it to every
request (constrained decoding to the reviewer's JSON Schema). Pi runs with `--no-tools`,
because a constrained JSON answer and tool calls exclude each other. The local reviewer
therefore judges the diff, spec and criteria in its prompt and does not open other files; the
Opus reviewer can. An invalid answer gets the same single retry as every reviewer
(`reviewWithRetry`); a second invalid answer is a step error. Checked with the real Pi binary
against a fake Ollama: the request carries the schema and no tools, and a prose answer is
retried once.

**Order of measurement (final block):**

1. `npm run eval:review` runs Opus and Pi on the frozen `evals/review/` set and reports recall,
   false positive rate and average time per review. The summary prints the owner's rule:
   `Pi gate: recall pi / opus = N% (threshold 70%) → PASS | FAIL`.
2. Only on PASS: one `npm run eval` with `reviewer: PI_OLLAMA_REVIEWER`, against the Week 3
   baseline. On FAIL there is no eval, and the result is recorded.

## Options considered (OpenAI is disabled for now)

Every option uses the same code; only `factory.config.ts` (and `.env` or a one-time login)
changes. "Independence" means: does a Pi reviewer make the review more independent of the
developer (Claude Opus), or does it only show that the runtime can be swapped?

| #   | Provider in Pi                                                                                                   | What it needs                                                 | Data goes to                    | Cost                                                 | Review independence                                                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | ~~Anthropic via the Claude Pro/Max subscription~~ (**excluded by the owner**; the config refuses it)             | One OAuth login into the factory's Pi agent dir; `keyEnv: []` | Anthropic (as today)            | Subscription                                         | **No**: same vendor and model family as the developer. Only shows that the runtime can be swapped. Check Anthropic's terms for subscriptions used in third-party clients first. |
| B   | Google Gemini API (e.g. `google/gemini-3.1-pro-preview`, `gemini-3.8-flash`)                                     | `GEMINI_API_KEY` in `.env` (already in `secretEnv`)           | Google                          | Billed per token; free tier has different data terms | **Yes**: another vendor and model family                                                                                                                                        |
| C   | GitHub Copilot subscription (`github-copilot/<model>`)                                                           | Copilot plan; device-flow login or `COPILOT_GITHUB_TOKEN`     | GitHub/Microsoft + model vendor | Subscription                                         | **Yes** with a non-Anthropic model (Gemini, Grok, Kimi); **no** with a Claude model                                                                                             |
| D   | Local model through Ollama (`models.json`, 127.0.0.1)                                                            | Pull a coding model (several GB); no key                      | Nothing leaves the machine      | $0                                                   | Yes in vendor terms, but a small local model is likely a weak reviewer; `eval:review` would show it                                                                             |
| E   | Other API keys: DeepSeek, Mistral, xAI, OpenRouter, …                                                            | The provider's key in `.env` and `secretEnv`                  | That vendor                     | Billed per token                                     | Yes                                                                                                                                                                             |
| F   | OpenAI (supported, currently off): `openai/<id>` with `OPENAI_API_KEY`, or the ChatGPT subscription via `/login` | Owner re-enables OpenAI                                       | OpenAI                          | API or subscription                                  | Yes (like the Week 2 Sol reviewer through OpenCode)                                                                                                                             |

Role choice:

- **Reviewer:** the natural place. `npm run eval:review -- --only pi` measures recall and false
  positive rate against the current reviewer on the frozen `evals/review/` set.
- **Planner:** also read-only. It is measured only by a full `npm run eval`.

Example configuration (option B, reviewer):

```ts
reviewer: { runtime: "pi", model: "google/gemini-3.1-pro-preview", keyEnv: ["GEMINI_API_KEY"] },
// and for eval:review:
reviewEval: { reviewers: [{ runtime: "claude-code", model: "opus" },
                          { runtime: "pi", model: "google/gemini-3.1-pro-preview", keyEnv: ["GEMINI_API_KEY"] }] },
```

A subscription login (options C, F; never Claude) is done once in the factory's own agent dir, never in
`~/.pi`:

```bash
PI_CODING_AGENT_DIR=~/agentic-factory-work/pi-agent HOME=~/agentic-factory-work/pi-agent/home npx pi
# then /login inside Pi, and quit
```

A local model (option D) goes into `~/agentic-factory-work/pi-agent/models.json`, as the
`ollama` example in Pi's `docs/models.md` shows. Use the URL `http://127.0.0.1:11434/v1`.

## Measurements (final block)

Once the owner has chosen:

- `npm run eval:review` (when Pi is a reviewer);
- one `npm run eval` with Pi in the chosen role, against the Week 3 baseline.

The role configuration for Phase 8 is the owner's decision, made by those numbers.
