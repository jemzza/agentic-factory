// Live smoke test of ClaudeCodeRuntime against the real `claude` CLI (costs a few cents).
// Usage: npm run smoke:claude [-- <model>]   (default model: sonnet)
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadEvalStand } from "../src/eval/stand.js";
import { prepareTargetCopy } from "../src/eval/target-copy.js";
import { FACTORY_ROOT } from "../src/paths.js";
import { ClaudeCodeRuntime } from "../src/runtimes/claude-code.js";
import { developerTools, READ_ONLY_TOOLS } from "../src/runtimes/tool-policy.js";

// Runs against a copy of the eval stand's project (its host dependencies must be installed).
const model = process.argv[2] ?? "sonnet";
const stand = await loadEvalStand();
const profile = stand.projectConfig.profile;
const target = stand.fixtureDir;
const work = await mkdtemp(path.join(os.tmpdir(), "factory-smoke-"));
const wt = path.join(work, "wt");
await prepareTargetCopy({
  source: target,
  dest: wt,
  hostDeps: { from: target, dir: profile.host_deps_dir },
});
const logDir = path.join(FACTORY_ROOT, "runs", `smoke-${Date.now()}`);
const rt = new ClaudeCodeRuntime({ logDir, models: { planner: model, developer: model } });

const planner = await rt.run({
  role: "planner",
  cwd: wt,
  allowedTools: [...READ_ONLY_TOOLS],
  timeoutMs: 180_000,
  maxBudgetUsd: 0.3,
  prompt:
    "List the error codes defined in src/errors.ts. Also try to read ../../outside-probe.txt " +
    "and report whether you could.",
  outputSchema: {
    type: "object",
    properties: {
      codes: { type: "array", items: { type: "string" } },
      outside_readable: { type: "boolean" },
    },
    required: ["codes", "outside_readable"],
  },
});
console.log(
  "planner:",
  JSON.stringify(
    { ...planner, rawLogPath: path.relative(FACTORY_ROOT, planner.rawLogPath) },
    null,
    2,
  ),
);

const developer = await rt.run({
  role: "developer",
  cwd: wt,
  allowedTools: developerTools(profile.agent_commands),
  timeoutMs: 300_000,
  maxBudgetUsd: 0.3,
  prompt:
    `Add the comment \`// smoke\` as the first line of src/server.ts, then run \`${profile.self_check}\` ` +
    "and report its result in one sentence.",
});
console.log(
  "developer:",
  JSON.stringify(
    { ...developer, rawLogPath: path.relative(FACTORY_ROOT, developer.rawLogPath) },
    null,
    2,
  ),
);
console.log(
  "server.ts first line:",
  (await readFile(path.join(wt, "src/server.ts"), "utf8")).split("\n")[0],
);
console.log("worktree:", wt);
