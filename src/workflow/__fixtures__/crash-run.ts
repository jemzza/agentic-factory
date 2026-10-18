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
  FAKE_REJECT,
  FAKE_TASK,
  fakeConfig,
  fakeExec,
  fakePlanner,
  fakeReviewer,
  FakeRuntime,
  FAKE_PROJECT,
} from "../../testing/fakes.js";

interface Args {
  /** `gate-after-review-fix`: the reviewer rejects once; killed in the gate after that rework. */
  crashIn: "develop" | "gate" | "gate-after-review-fix";
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
  reviewer: fakeReviewer(args.crashIn === "gate-after-review-fix" ? FAKE_REJECT : FAKE_APPROVE),
});
let gateCommands = 0;
const exec: SandboxExec = async (wt, cmd, t) => {
  gateCommands += 1;
  if (args.crashIn === "gate") die();
  // Each gate runs two checks; the third command is the gate after the review rework.
  if (args.crashIn === "gate-after-review-fix" && gateCommands > 2) die();
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
    project: FAKE_PROJECT,
    ensureRepo: () => Promise.resolve({ dir: args.repoDir, baseCommit: args.baseCommit }),
    makeSandboxExec: () => Promise.resolve(exec),
    specApprovalMode: "auto",
  },
  { runId: args.runId },
);
// Reaching this line means the crash did not happen.
process.exit(3);
