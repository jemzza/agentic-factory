# Merge decision needed — Завершение задачи (`complete-task`)

The run passed the sandboxed gate and the review. Nothing is merged without you.

- Branch: `factory/complete-task-20261016-062925-e708`

- Report: <factory>/runs/20261016-062925-e708/report.md

```bash

npm run merge -- 20261016-062925-e708

npm run close -- 20261016-062925-e708 --comment "why not merged"

```

`merge` re-runs the gate on the merge result with the current main and moves main only if it passes.
