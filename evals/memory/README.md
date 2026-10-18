# Memory A/B set (frozen)

Measures whether project memory helps: does a decision a human made on one task (A) reach a
later task (B) that never mentions it? Design: `docs/week3-design.md` §11. Runner:
`npm run eval:memory` (`src/eval/memory-ab.ts`).

**Frozen.** `MANIFEST.sha256` lists every file here. `eval:memory` refuses to run when the
set differs from it, and a test checks the same thing. Pairs, recorded reject comments, B's
hidden tests and the reference patches are not changed after the first A/B run.

## Pairs (`pairs.yaml`)

| Pair                 | A (rejected once) | B (measured)     | Decision in the recorded comment                                |
| -------------------- | ----------------- | ---------------- | --------------------------------------------------------------- |
| `strict-action-body` | `start-task`      | `duplicate-task` | action endpoints take no body; any body field is 400            |
| `noop-flag-actions`  | `pin-task`        | `star-task`      | repeating a flag action is a no-op: 200, `updatedAt` not bumped |
| `bulk-limit-50`      | `bulk-delete`     | `bulk-complete`  | bulk endpoints accept at most 50 ids                            |
| `free-text-fields`   | `assignee-field`  | `location-field` | new text fields: trimmed, empty → null, at most 100 characters  |

No B task mentions its decision, and TaskFlow's `CLAUDE.md` does not state any of them.
One is partly implied: `CLAUDE.md` says unknown body keys are 400, so a careful developer may
apply `strict-action-body` without memory. That pair is weaker evidence than the other three.
B's hidden tests check the decision in a test titled `[lesson] …`, plus B's own criteria.

## Protocol (per pair)

- `memory_on`: in a namespace of its own (`<project>~memeval-<ts>-<pair>`), A runs once. Its
  first spec is rejected with the recorded comment (recorded as a CLI decision of the actor
  `recorded-comment`), and the revised spec is approved. The planner turns the comment into
  `lessons`, which are stored when the revised spec is approved. Then B runs `--repeat` times
  (default 2) with memory **required** and **read-only**: B's own findings never reach the
  next repeat.
- `memory_off`: B runs `--repeat` times without memory.
- B's specs are approved automatically. Eval never merges.
- If memory is unavailable (Ollama stopped, model missing, digest moved), the A/B stops with
  `infra_error`. `memory_on` never silently becomes `memory_off`.

4 A + 8 B (on) + 8 B (off) = 20 task runs with the default `--repeat 2`. With n = 2 only large
effects are visible; a result within the spread is recorded as such.

## Layout

- `tasks/<id>/task.yaml`: visible tasks, A and B.
- `hidden/<b-id>/`: B's hidden tests and `meta.yaml` (never shown to agents). The tests use
  the shared harness `evals/hidden/_harness.ts`.
- `reference/<b-id>.patch`: reference implementations that follow the decision. Used only by
  `npm run eval:memory -- verify`: hidden tests fail on the baseline and pass on the reference.
