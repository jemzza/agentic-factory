// Child-process fixture for resilience tests: starts a run with fake agents and kills
// itself with SIGKILL in the middle of a node (no cleanup, no graceful shutdown).
// Usage: node --import tsx crash-run.ts '<json args>'
import { runTask } from "../../pipeline/run-task.js";
import type { SandboxExec } from "../../quality/gate.js";
import { openDb } from "../../store/db.js";
import { Store } from "../../store/store.js";
import {
  appendingDeveloper,
  FAKE_APPROVE,
  FAKE_TASK,
  fakeConfig,
  fakeExec,
  fakePlanner,
  fakeReviewer,
  FakeRuntime,
} from "../../testing/fakes.js";

interface Args {
  crashIn: "develop" | "gate";
  dbPath: string;
  workdir: string;
  runsDir: string;
  repoDir: string;
  baseCommit: string;
  runId: string;
}

const args = JSON.parse(process.argv[2] ?? "{}") as Args;
const die = () => process.kill(process.pid, "SIGKILL");

const runtime = new FakeRuntime({
  planner: fakePlanner(),
  // Crash after the developer has already written part of its change.
  developer: appendingDeveloper(undefined, args.crashIn === "develop" ? die : undefined),
  reviewer: fakeReviewer(FAKE_APPROVE),
});
const exec: SandboxExec = async (wt, cmd, t) => {
  if (args.crashIn === "gate") die();
  return fakeExec(wt, cmd, t);
};

const store = new Store(openDb(args.dbPath));
await runTask(
  FAKE_TASK,
  {
    config: fakeConfig(args.workdir),
    runtime,
    runsDir: args.runsDir,
    store,
    ensureRepo: () => Promise.resolve({ dir: args.repoDir, baseCommit: args.baseCommit }),
    makeSandboxExec: () => Promise.resolve(exec),
  },
  { runId: args.runId },
);
// Reaching this line means the crash did not happen.
process.exit(3);
