# Demo (5–7 minutes)

One factory, two projects on different stacks, driven from GitHub. The demo runs in its own
sandbox: its own database, workdir, `runs/` and project registry. **The working
`data/factory.db`, `runs/` and workdir are never touched.** GitHub is not reset: the two demo
repositories are dedicated test repositories, and every demo opens new issues.

Agent steps take minutes, not seconds (planner ≈ 1 min, developer 2–5 min, review ≈ 0.5 min).
So the second project's run is started before the audience arrives, and the steps below
overlap.

## Before (T − 20 min)

```bash
npm run demo:reset -- --owner <github-login>   # wipes and recreates ~/agentic-factory-demo (projects.demo.yaml)
npm run provider:check -- ollama               # the Pi reviewer's local model (step 6)
claude auth status                             # Claude Code logged in
```

- `.env` has `FACTORY_GITHUB_TOKEN`: a fine-grained token for `taskflow-demo` and
  `ledgerlite` only.
- Laptop on AC power, lid open.

**Terminals:**

- **A:** `npm run demo -- watch`, the factory polling GitHub every 60 s.
- **B:** `npm run demo -- dashboard`, then open <http://127.0.0.1:4317/>.
- **C:** a free shell.

**Pre-start the second project (for step 5).** In `ledgerlite`, open an issue with the
**Factory task** template, for example:

- Title: "Account balance as of a date".
- Request: "Add a function that returns an account's balance as of a given date."
- Criteria: one per line.

Then comment `/approve` once the spec comment appears. By the time of the demo it has a PR.

## 1. Issue → spec → `/reject` → new spec → `/approve` (≈ 1.5 min)

1. In `taskflow-demo`, open an issue with the **Factory task** template:
   - Title: "Archive a task".
   - Request: "Add POST /tasks/:id/archive that marks a task archived."
   - Criteria:
     - "200 with the archived task"
     - "a deleted task → 409 CONFLICT"
     - "unknown id → 404 NOT_FOUND"
2. Within one poll the issue gets the label `factory:in-progress`. Then a comment arrives with
   the OpenSpec change (spec v1, its hash) and the label `factory:spec-review`.
3. Comment: `/reject Archived tasks must disappear from GET /tasks; say so in the spec`.
   The factory answers with spec v2, which has a requirement for the list.
4. Comment `/approve`. It applies to v2 only: an approval of an older version would be
   refused. The label goes back to `factory:in-progress`.

Point out:

- Commands count only from `allowed_users`.
- The factory's own comments carry `<!-- factory:bot -->` and are never commands.
- Every comment is decided exactly once (`github_events`).

## 2. Kill the factory during `develop`, restart, it continues (≈ 1 min)

While the run is at node `develop` (the dashboard shows it), in
terminal C:

```bash
pkill -9 -f "src/cli.ts watch"     # a crash, not a graceful stop
```

Restart terminal A with `npm run demo -- watch`. On start it resumes interrupted runs from
their last LangGraph checkpoint:

- planning is not repeated;
- the developer node restarts from the last committed worktree state (idempotent replay);
- the run's event feed on the dashboard shows `resume`.

## 3. The PR and its report (≈ 1 min)

When the run succeeds, the issue gets a PR link and the label `factory:pr-open`. Show the PR
description:

- spec version and hash;
- gate checks (typecheck, test) with their results;
- the review verdict and issues;
- gate and review cycles;
- cost against the budget;
- the memory section (off by default).

## 4. `/merge` → gate again → merge, issue closed (≈ 0.5 min)

Comment `/merge` on the PR. The factory then:

- merges `--no-ff` locally;
- archives the OpenSpec change;
- runs the gate again on the merge result in the sandbox;
- pushes the target branch (never forced).

The PR shows as merged, the issue is closed with `factory:done`, and the run is `merged` on
the dashboard.

## 5. The same factory in the second project, another stack (≈ 0.5 min)

Open the pre-started `ledgerlite` PR (Python 3.12: pytest, mypy, ruff in the `python312`
sandbox profile). The same factory code and graph run it; only the project's
`.factory/config.yaml` differs. On the dashboard, filter Runs by project: `taskflow-demo` and
`ledgerlite`.

## 6. Switching the reviewer runtime with one line (≈ 0.5 min)

In `factory.config.ts`:

```ts
reviewer: OPUS_REVIEWER,        // →  reviewer: PI_OLLAMA_REVIEWER,
```

From the next run on, the reviewer is Pi on a local Ollama model: another vendor, $0, nothing
leaves the machine. No code changes; the config is validated at start. The measured trade-off
(`eval:review`): Opus found 10/10 defects, the local 7B model 2/10. That is why Opus stays the
default ([pi-runtime.md](pi-runtime.md)). Revert the line after the demo.

## 7. Dashboard (≈ 1 min)

At <http://127.0.0.1:4317/> (read-only, 127.0.0.1 only):

- **Runs:** both projects, filter by project and status, issue and PR links.
- **A run:** spec, diff, gate, review, the approvals with channel `github`, and the event
  feed, including the `resume` from step 2.
- **Evals:** metrics, and a comparison of two evals on the same baseline. The demo database
  has no evals. For this part, run `npm run dashboard -- --port 4318`, which reads the working
  database (read-only).

## After

```bash
npm run demo:reset -- --owner <github-login>   # optional: a clean sandbox for the next demo
```

Close leftover demo issues or PRs by hand on GitHub if a step was aborted. `demo:reset` never
changes GitHub.
