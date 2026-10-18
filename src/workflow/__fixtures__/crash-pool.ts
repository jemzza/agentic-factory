// Child-process fixture: four runs in parallel; every developer writes its change and waits
// until all four have written; then the process kills itself with SIGKILL, so four runs are
// cut off in the middle of `develop` at once (no cleanup, no graceful shutdown).
// Usage: node --import tsx crash-pool.ts '<json args>'
import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { runTask } from "../../pipeline/run-task.js";
import { openDb } from "../../store/db.js";
import { Store } from "../../store/store.js";
import {
  FAKE_APPROVE,
  FAKE_TASK,
  fakeConfig,
  fakeExec,
  fakePlanner,
  fakeReviewer,
  FakeRuntime,
  FAKE_PROJECT,
} from "../../testing/fakes.js";

interface Args {
  dbPath: string;
  workdir: string;
  runsDir: string;
  repoDir: string;
  baseCommit: string;
  runIds: string[];
  line: string;
}

const args = JSON.parse(process.argv[2] ?? "{}") as Args;
let written = 0;
const runtime = new FakeRuntime({
  planner: fakePlanner(),
  developer: async (input) => {
    await mkdir(path.join(input.cwd, "src"), { recursive: true });
    await appendFile(path.join(input.cwd, "src", "feature.ts"), args.line);
    written++;
    if (written === args.runIds.length) process.kill(process.pid, "SIGKILL");
    await new Promise(() => undefined); // wait for the kill
    return {};
  },
  reviewer: fakeReviewer(FAKE_APPROVE),
});

const store = new Store(openDb(args.dbPath));
await Promise.all(
  args.runIds.map((runId, i) =>
    runTask(
      { ...FAKE_TASK, id: `task-${i + 1}` },
      {
        config: fakeConfig(args.workdir),
        runtime,
        runsDir: args.runsDir,
        store,
        project: FAKE_PROJECT,
        ensureRepo: () => Promise.resolve({ dir: args.repoDir, baseCommit: args.baseCommit }),
        makeSandboxExec: () => Promise.resolve(fakeExec),
        specApprovalMode: "auto",
      },
      { runId },
    ),
  ),
);
