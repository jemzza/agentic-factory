# Reviewer evaluation set (`npm run eval:review`)

Fixed **before the first reviewer run** (Week 2, Phase 6) and never tuned to a reviewer
afterwards. `MANIFEST.sha256` pins every file; `src/eval/review-cases.test.ts` fails if a case
changes. Changing the set requires an explicit human decision and a new manifest, called out in
the commit message.

## Cases

15 diffs against the TaskFlow baseline (`factory-baseline`), each reviewed with its task's
visible definition (`evals/tasks/<task>/task.yaml`) — exactly what the reviewer node sees:

- `c01`–`c05`: correct implementations (the reference patches unchanged). Hidden tests pass.
- `d01`–`d10`: a reference patch with ONE injected defect. Every defect diff still passes
  `npm run check` (the covering test was removed or bent), i.e. it would get past the gate —
  catching it is the reviewer's job. 7 defects are also caught by the hidden tests
  (`hidden_tests_fail: true`); 3 are not behavioral (`d03` test without assertions,
  `d04` out-of-scope change, `d05` internal error leaked to clients).

| Case | Category                                           |
| ---- | -------------------------------------------------- |
| d01  | missing check of a deleted task                    |
| d02  | wrong HTTP status code (400 instead of 409)        |
| d03  | test without assertions                            |
| d04  | change outside the allowed paths                   |
| d05  | internal error / stack trace leaked in responses   |
| d06  | non-atomic bulk update (partial writes on failure) |
| d07  | missing uniqueness check on restore                |
| d08  | cursor breaks when a task is deleted between pages |
| d09  | history entry for an unchanged status              |
| d10  | RegExp built from user input                       |

## Scoring (fixed before the first run)

A review is the reviewer's structured verdict, judged with the same `isApproved` rule as the
pipeline (approve, every criterion met, no blocker/major issue).

- **Defect found (strict)**: not approved **and** at least one `blocker`/`major` issue whose
  `file` is one of the defect's `files` (exact path or path suffix).
- **Defect flagged (lenient)**: not approved, regardless of the issues' files.
- **Recall** = found / 10 (strict; lenient reported alongside).
- **False positive** (clean case): not approved. **FPR** = false positives / 5.
- An invalid reviewer answer after the single retry counts as "not found" / "not flagged"
  for that case and is reported separately as an error.
