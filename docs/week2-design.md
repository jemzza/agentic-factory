# Week 2 design (Phase 0)

Baseline (`runs/eval-20261015-130103/summary.md`): verified 10/10, false success 0/9,
0 fix cycles, avg 146.2s/task, $5.28 total, Opus for all roles.

## Versions to pin (checked on npm and installed in a scratch dir)

| Package                                  | Version                      | Notes                                                                                |
| ---------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| `@langchain/langgraph`                   | 1.5.0                        | peers `zod ^4.2`, `@langchain/core ^1.1.48`; `StateSchema` accepts Zod fields        |
| `@langchain/core`                        | 1.2.17                       | required peer                                                                        |
| `@langchain/langgraph-checkpoint-sqlite` | 1.1.0                        | official `SqliteSaver`; depends on `better-sqlite3 ^12`                              |
| `better-sqlite3`                         | ^12 (same copy as the saver) | 13.x exists, but one shared copy avoids two native builds                            |
| `@fission-ai/openspec`                   | 1.14.2                       | CLI `openspec`, Node ≥ 20.19, project dependency (run by the factory, not by agents) |
| `opencode-ai`                            | 1.19.0                       | CLI `opencode` (native per-platform binary)                                          |

**SQLite driver: `better-sqlite3`.** The official checkpointer already requires it, so one
driver and one DB file serve both LangGraph checkpoints and our tables (single file, one
backup, transactions across both if ever needed). `node:sqlite` would add a second engine
and is still flagged experimental on Node 22. Cost: a native addon tied to the Node ABI —
see risks.

## Verified behavior (scratch probes, not assumptions)

LangGraph (`SqliteSaver` on a file, 3-node graph + interrupt):

- Process killed with `process.exit` inside node `b` → new process `invoke(null, {thread_id})`
  re-runs **`b` from its start**; the completed node `a` is **not** re-run.
- `interrupt()` → `result.__interrupt__ = [{value}]`, `getState().next = ["approve"]`.
- `invoke(new Command({ resume: true }))` → the interrupt node restarts, `interrupt()` returns
  `true`, the graph continues.
- `invoke(null)` on a finished thread → no-op, `next = []`, state intact.

OpenSpec 1.14.2 (temp git repo, `OPENSPEC_TELEMETRY=0 DO_NOT_TRACK=1 OPENSPEC_NO_UPDATE_CHECK=1`):

- `openspec init --tools none .` → `openspec/{config.yaml, specs/, changes/archive/}`, no AI-tool files.
- A change = `openspec/changes/<id>/` with `proposal.md` (Why / What Changes / Capabilities /
  Impact), `specs/<capability>/spec.md` (`## Purpose` ≥ 50 chars for new capabilities;
  `## ADDED|MODIFIED|REMOVED|RENAMED Requirements`; `### Requirement:` with SHALL/MUST; each
  requirement needs `#### Scenario:` with exactly four `#`), `tasks.md`; `design.md` optional.
- `openspec validate <id> --strict --json --no-interactive` → exit 1 + `items[].issues[]`
  `{level, path, line?, message}` on errors; exit 0 when valid.
- `openspec archive <id> -y --json` → moves the change to `changes/archive/<date>-<id>/` and
  merges deltas into `openspec/specs/`; works with unchecked tasks. A second call fails with
  `archive_change_not_found` → the merge node checks for an existing archive first.

OpenCode 1.19.0:

- `opencode run [message] -m <provider/model> --format json --dir <cwd>`; `--auto` must not be
  used (auto-approves). No schema-constrained output flag → the reviewer must answer with a
  JSON object in its final text, which we extract and validate with Zod.
- Read-only via `OPENCODE_PERMISSION` / `OPENCODE_CONFIG_CONTENT`:
  `{"*":"deny","read":"allow","grep":"allow","glob":"allow","external_directory":"deny"}`
  (documented keys; last matching rule wins).
- Isolation env: `OPENCODE_DISABLE_PROJECT_CONFIG`, `OPENCODE_DISABLE_CLAUDE_CODE` (it reads
  `~/.claude/CLAUDE.md` and `.claude/` by default), `OPENCODE_DISABLE_AUTOUPDATE`,
  `OPENCODE_DISABLE_SHARE`, `OPENCODE_DISABLE_DEFAULT_PLUGINS`, `OPENCODE_DISABLE_LSP_DOWNLOAD`.
- **Not documented, must be probed live (needs credentials):** the `--format json` event
  stream (final text, tokens, cost), exit codes, and what `"ask"`/`"deny"` do in `run` mode.
- No credentials are configured (`opencode providers list` → 0).

## State (Zod, the graph's `StateSchema`)

All fields are last-value channels; history lives in SQLite (`steps`, `events`), not in state.

```ts
const RoleBinding = z.strictObject({
  runtime: z.enum(["claude-code", "opencode"]),
  model: z.string(),
});

const RunStateSchema = {
  // identity & configuration (set once by the CLI)
  runId: z.string(), // = LangGraph thread_id
  task: TaskSpecSchema,
  mode: z.enum(["interactive", "eval"]),
  specApproval: z.enum(["manual", "auto"]),
  roles: z.strictObject({ planner: RoleBinding, developer: RoleBinding, reviewer: RoleBinding }),
  startedAt: z.string(),
  deadlineMs: z.number(),
  budgetUsd: z.number(),

  // accounting (updated by agent nodes)
  spentUsd: z.number().default(0),
  unknownCostSteps: z.number().default(0),

  // workspace
  repo: z.strictObject({ dir: z.string(), baseCommit: z.string() }).nullable().default(null),
  worktree: WorktreeSchema.nullable().default(null),
  headCommit: z.string().nullable().default(null), // worktree is clean at this commit after every node
  specCommit: z.string().nullable().default(null), // commit with the approved spec; base of the developer diff

  // planning & spec
  plan: PlannerOutputSchema.nullable().default(null),
  spec: OpenSpecChangeSchema.nullable().default(null), // structured spec + rendered file paths
  specValidation: z.array(OpenSpecIssueSchema).default([]),
  specAttempts: z.number().default(0),
  specRejections: z.array(z.string()).default([]), // human comments, max 2 before needs_clarification

  // development loop
  cycle: z.number().default(0), // 0 = first implementation
  feedback: FixFeedbackSchema.nullable().default(null),
  gate: GateResultSchema.nullable().default(null),
  review: ReviewVerdictSchema.nullable().default(null),

  // outcome
  lastError: z
    .strictObject({ node: z.string(), kind: StepErrorKind, message: z.string() })
    .nullable()
    .default(null),
  status: RunStatusSchema.default("running"),
  statusMessage: z.string().default(""),
  merge: z
    .strictObject({ mergeCommit: z.string(), archivedAs: z.string() })
    .nullable()
    .default(null),
};
```

`RunStatus` = Week 1 statuses + `running`, `awaiting_spec_approval`,
`awaiting_merge_approval`, `merged`, `closed`. The resume value of each interrupt is
validated with a Zod `responseSchema`:
`spec_approval: {decision: "approve" | "reject", comment?}`,
`merge_approval: {decision: "merge" | "close", comment?}`.

## SQLite (`data/factory.db`, git-ignored; same file holds LangGraph's checkpoint tables)

Migrations: `migrations/NNN_name.sql`, applied in order inside a transaction, recorded in
`schema_migrations`. No ORM; queries in `src/store/*.ts` with Zod-parsed rows.

```sql
CREATE TABLE schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  applied_at  TEXT NOT NULL
);

CREATE TABLE runs (
  id              TEXT PRIMARY KEY,           -- runId = LangGraph thread_id
  task_id         TEXT NOT NULL,
  mode            TEXT NOT NULL CHECK (mode IN ('interactive','eval')),
  eval_id         TEXT,                       -- set for eval runs (eval-<ts>-r<n>)
  status          TEXT NOT NULL,
  status_message  TEXT NOT NULL DEFAULT '',
  spec_approval   TEXT CHECK (spec_approval IN ('manual','auto')),
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  updated_at      TEXT NOT NULL,
  cost_usd        REAL NOT NULL DEFAULT 0,
  budget_usd      REAL NOT NULL,
  unknown_cost_steps INTEGER NOT NULL DEFAULT 0,
  fix_cycles      INTEGER NOT NULL DEFAULT 0,
  roles_json      TEXT NOT NULL,              -- {"planner":{"runtime","model"},...}
  worktree_path   TEXT,
  branch          TEXT,
  base_commit     TEXT,
  head_commit     TEXT,
  report_path     TEXT,
  locked_by       TEXT                        -- "<host>:<pid>" while a process drives the run
);
CREATE INDEX runs_task ON runs(task_id);
CREATE INDEX runs_status ON runs(status);

CREATE TABLE steps (
  id            INTEGER PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs(id),
  node          TEXT NOT NULL,
  cycle         INTEGER NOT NULL DEFAULT 0,
  attempt       INTEGER NOT NULL,             -- 2+ when the node was replayed after a crash
  status        TEXT NOT NULL CHECK (status IN ('running','ok','failed','abandoned','interrupted')),
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  duration_ms   INTEGER,
  cost_usd      REAL,
  runtime       TEXT,
  model         TEXT,
  log_path      TEXT,
  error_kind    TEXT,
  error_message TEXT,
  UNIQUE (run_id, node, cycle, attempt)
);

CREATE TABLE events (
  id        INTEGER PRIMARY KEY,
  run_id    TEXT NOT NULL REFERENCES runs(id),
  ts        TEXT NOT NULL,
  kind      TEXT NOT NULL CHECK (kind IN ('node_start','node_end','transition','interrupt','resume','status')),
  node      TEXT,
  next      TEXT,                              -- target of a transition
  payload   TEXT                               -- JSON: state delta (secrets never included)
);
CREATE INDEX events_run ON events(run_id, id);

CREATE TABLE approvals (
  id          INTEGER PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id),
  gate        TEXT NOT NULL CHECK (gate IN ('spec','merge')),
  decision    TEXT NOT NULL CHECK (decision IN ('approve','reject','merge','close')),
  actor       TEXT NOT NULL,                   -- OS user for manual, 'auto' for --auto-approve-spec
  comment     TEXT,
  decided_at  TEXT NOT NULL
);
```

On `resume`, any `steps` row still `running` from a dead process becomes `abandoned`, and the
replayed node gets `attempt + 1`. `locked_by` prevents two processes (e.g. `resume` and
`approve`) from driving one run at the same time.

## Questions (need your decision)

1. **OpenCode reviewer model and credentials.** Which provider/model (must differ from the
   developer's Opus; a different vendor gives a more independent review), and how will you
   provide its API key (`.env`, passed only to the OpenCode process)?
2. **Planner stays read-only.** The task says the Planner "creates the change proposal". I
   propose the Planner returns the spec as structured JSON (capability, purpose,
   requirements with scenarios, tasks) and the `spec_draft` node renders the OpenSpec files
   deterministically and runs `openspec validate`. This keeps the Planner without write
   tools and makes most format errors impossible. OK?
3. **Merges vs. eval baseline.** `npm run merge` moves TaskFlow's `main`. Eval must keep
   starting from the original baseline, so I'd tag it `factory-baseline` and branch eval runs
   from the tag, interactive runs from `main`. OK?
4. **Scope of the developer diff.** Spec files are committed by the factory before
   `develop`; the scope check then applies to `specCommit..HEAD`, so `openspec/**` stays
   outside `allowed_paths` and the developer cannot edit the approved spec. OK?
5. **Spend for the week.** Phase 2 equivalence eval ≈ $5–6, Phase 7 `--repeat 3` ≈ $18–25
   (spec drafting adds a little per task), `eval:review` = 15 diffs × 2 reviewers (small).
   Total ≈ $30–40 at list price. OK?

## Risks

- **OpenCode output is undocumented.** The JSON event format, cost/token fields and exit
  codes must be probed live; there is no schema-constrained output, so invalid reviewer
  answers will be more frequent (mitigation: strict JSON-only instruction, extraction of
  the last JSON object, Zod, one retry as required).
- **OpenCode read-only is only as strong as its permission system;** `"ask"` behavior in
  `run` mode is undocumented. Mitigation: explicit `deny` for everything but read/grep/glob,
  isolation env vars, and a live probe like Week 1's (write/bash/outside-read must be denied).
- **Native addon / Node ABI.** `better-sqlite3` broke when the shell switched between Homebrew
  Node 25 and nvm Node 22 (`NODE_MODULE_VERSION` mismatch, fixed by `npm rebuild`). Mitigation:
  `.nvmrc` + `engines` + a clear error message in `check`.
- **Replay cost.** A crash inside an agent node re-runs the agent (and pays again); cost of
  the lost attempt is unknown (`unknown_cost_steps`).
- **Baseline is saturated (10/10).** "Not worse than baseline" leaves no headroom: one miss in
  30 runs is a measurable drop. Phase 7 will report mean ± spread and explain any miss.
- **More moving parts per run.** Spec drafting adds an agent turn and validation; time and
  cost per task will rise versus the baseline — reported, not hidden.
- **OpenSpec telemetry/update checks** must be disabled via env for every CLI call.
