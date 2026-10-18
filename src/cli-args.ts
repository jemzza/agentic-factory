import { PROJECT_ID_PATTERN } from "./schemas/project.js";
import { TASK_ID_PATTERN } from "./schemas/task.js";

export const RUN_ID_PATTERN = /^\d{8}-\d{6}-[0-9a-f]{4}$/;

export type CliCommand =
  | {
      kind: "run";
      /** Project from projects.yaml (default: the eval stand's project). */
      projectId: string | null;
      /** A task YAML file, or the id of an eval task. */
      task: string;
      autoApproveSpec: boolean;
    }
  | {
      kind: "decide";
      runId: string;
      gate: "spec" | "merge";
      decision: "approve" | "reject" | "merge" | "close";
      comment: string | null;
    }
  | { kind: "baseline-update"; reason: string }
  | { kind: "reopen-merge"; runId: string }
  | { kind: "eval-review"; only: string | null }
  | {
      kind: "eval-memory";
      /** verify: check the pairs' hidden tests (fail on baseline, pass on reference); no agents. */
      action: "run" | "verify" | "freeze";
      repeat: number;
      costCapUsd: number | null;
    }
  | {
      kind: "eval";
      taskIds: string[];
      repeat: number;
      /** Continue this eval (interrupted passes, then more repeats). */
      resume: string | null;
      /** Override of the config's evalCostCapUsd for this eval (USD, all repeats). */
      costCapUsd: number | null;
      /** Tasks run in parallel (default 1). */
      concurrency: number;
    }
  | { kind: "verify-hidden"; taskId: string | null }
  | { kind: "eval-rescore"; evalId: string }
  | { kind: "project-check"; projectId: string }
  | {
      kind: "memory";
      action: "list" | "show" | "remove" | "export" | "reindex" | "check";
      /** Project (required for list/show/remove/export). */
      projectId: string | null;
      id: string | null;
    }
  | { kind: "watch"; once: boolean; intervalSeconds: number | null; concurrency: number }
  | { kind: "runs"; limit: number }
  | { kind: "resume"; runId: string }
  | { kind: "db-import" }
  | { kind: "help" }
  | { kind: "invalid"; message: string };

export const USAGE = `Usage:
  npm run run-task -- [--project <id>] <task.yaml | evalTaskId> [--auto-approve-spec]
                                 Run one task in a project (default: the eval stand's project);
                                 stops for spec approval unless --auto-approve-spec
  npm run approve -- <runId> spec
  npm run reject -- <runId> spec --comment "..."
                                 Approve the OpenSpec change, or send it back to planning
  npm run merge -- <runId>       Merge a successful run into main (gate re-runs on the merge result)
  npm run close -- <runId> --comment "..."
                                 Close a successful run without merging
  npm run eval:review [-- --only <claude-code|opencode>]
                                 Compare reviewers on evals/review/ (recall, false positive rate)
  npm run eval:memory [-- --repeat N] [-- --cost-cap USD]
  npm run eval:memory -- verify | freeze
                                 Memory A/B on the frozen evals/memory/ pairs (A once with the
                                 recorded rejection, B N times with and without memory; needs
                                 Ollama: stops infra_error without it). verify: hidden tests of
                                 the pairs; freeze: write MANIFEST.sha256 (before the first run)
  npm run reopen-merge -- <runId> One-time: put a success run from before the merge gate at it
  npm run baseline:update -- --reason "..."
                                 Move the factory-baseline tag to main (recorded in the DB)
  npm run eval [-- [--repeat N] [--concurrency N] [--cost-cap USD] [--resume <evalId>] <taskId>...]
                                 Run the eval suite (all tasks, or the given ones) N times and
                                 verify successes with hidden tests. --resume continues an eval
                                 interrupted by a provider limit and/or adds repeats up to N
  npm run factory:watch [-- --once] [-- --interval <seconds>] [-- --concurrency N]
                                 Poll GitHub for factory issues and commands in every project
                                 of projects.yaml; one instance; Ctrl+C stops after the node
  npm run memory -- list|export --project <id>
  npm run memory -- show|remove <memoryId> --project <id>
  npm run memory -- reindex | check
                                 Project memory: inspect, remove, export (JSON); rebuild the
                                 index from the canonical records; live check of the embedder
  npm run project:check -- <projectId>
                                 Check a project's .factory/config.yaml, sandbox image and that
                                 its checks pass on a clean target branch (no agents)
  npm run eval:rescore -- <evalId>
                                 Re-judge a finished eval with the current hidden tests: stored
                                 final diffs on factory-baseline, no agent calls ($0)
  npm run verify-hidden [-- <taskId>]
                                 Check hidden tests: fail on baseline, pass on the reference
  npm run resume -- <runId>      Continue an interrupted run from its last checkpoint
  npm run runs [-- <limit>]      List recent runs from the database
  npm run db:import              Import run reports from runs/ into the database`;

export function parseCliArgs(argv: readonly string[]): CliCommand {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return { kind: "help" };
    case "run": {
      let projectId: string | null = null;
      let autoApproveSpec = false;
      const positional: string[] = [];
      for (let k = 0; k < rest.length; k++) {
        const a = rest[k] ?? "";
        if (a === "--auto-approve-spec") autoApproveSpec = true;
        else if (a === "--project") {
          const id = rest[++k];
          if (id === undefined || !PROJECT_ID_PATTERN.test(id)) {
            return { kind: "invalid", message: "run: --project expects a project id" };
          }
          projectId = id;
        } else positional.push(a);
      }
      const [task, ...extra] = positional;
      if (task === undefined) return { kind: "invalid", message: "run: missing <task>" };
      if (extra.length > 0) {
        return { kind: "invalid", message: `run: unexpected arguments: ${extra.join(" ")}` };
      }
      const isFile = /\.ya?ml$/.test(task);
      if (!isFile && !TASK_ID_PATTERN.test(task)) {
        return {
          kind: "invalid",
          message: `run: invalid taskId "${task}" (expected kebab-case, or a .yaml task file)`,
        };
      }
      return { kind: "run", projectId, task, autoApproveSpec };
    }
    case "eval": {
      let repeat = 1;
      let resume: string | null = null;
      let costCapUsd: number | null = null;
      let concurrency = 1;
      const ids: string[] = [];
      for (let k = 0; k < rest.length; k++) {
        const a = rest[k] ?? "";
        if (a === "--repeat") {
          const n = rest[++k];
          if (n === undefined || !/^[1-9]$/.test(n)) {
            return { kind: "invalid", message: "eval: --repeat expects a number from 1 to 9" };
          }
          repeat = Number(n);
        } else if (a === "--resume") {
          const id = rest[++k];
          if (id === undefined || !/^eval-\d{8}-\d{6}$/.test(id)) {
            return {
              kind: "invalid",
              message: "eval: --resume expects an eval id (eval-YYYYMMDD-HHMMSS)",
            };
          }
          resume = id;
        } else if (a === "--concurrency") {
          const v = rest[++k];
          if (v === undefined || !/^[1-8]$/.test(v)) {
            return { kind: "invalid", message: "eval: --concurrency expects 1 to 8" };
          }
          concurrency = Number(v);
        } else if (a === "--cost-cap") {
          const v = Number(rest[++k]);
          if (!Number.isFinite(v) || v <= 0 || v > 100) {
            return { kind: "invalid", message: "eval: --cost-cap expects USD in (0, 100]" };
          }
          costCapUsd = v;
        } else if (TASK_ID_PATTERN.test(a)) {
          if (!ids.includes(a)) ids.push(a);
        } else {
          return { kind: "invalid", message: `eval: invalid taskId(s): ${a}` };
        }
      }
      return { kind: "eval", taskIds: ids, repeat, resume, costCapUsd, concurrency };
    }
    case "watch": {
      let once = false;
      let intervalSeconds: number | null = null;
      let concurrency = 1;
      for (let k = 0; k < rest.length; k++) {
        const a = rest[k];
        if (a === "--once") once = true;
        else if (a === "--interval") {
          const v = Number(rest[++k]);
          if (!Number.isInteger(v) || v < 15 || v > 3600) {
            return { kind: "invalid", message: "watch: --interval expects 15..3600 seconds" };
          }
          intervalSeconds = v;
        } else if (a === "--concurrency") {
          const v = rest[++k];
          if (v === undefined || !/^[1-8]$/.test(v)) {
            return { kind: "invalid", message: "watch: --concurrency expects 1 to 8" };
          }
          concurrency = Number(v);
        } else return { kind: "invalid", message: `watch: unexpected argument ${a ?? ""}` };
      }
      return { kind: "watch", once, intervalSeconds, concurrency };
    }
    case "memory": {
      const [action, ...more] = rest;
      let projectId: string | null = null;
      const positional: string[] = [];
      for (let k = 0; k < more.length; k++) {
        if (more[k] === "--project") {
          const v = more[++k];
          if (v === undefined || !PROJECT_ID_PATTERN.test(v)) {
            return { kind: "invalid", message: "memory: --project expects a project id" };
          }
          projectId = v;
        } else positional.push(more[k] ?? "");
      }
      const actions = ["list", "show", "remove", "export", "reindex", "check"] as const;
      const a = actions.find((x) => x === action);
      if (!a) return { kind: "invalid", message: `memory: expected one of ${actions.join(", ")}` };
      const needsId = a === "show" || a === "remove";
      const needsProject = a !== "reindex" && a !== "check";
      const id = positional[0] ?? null;
      if (needsProject && projectId === null) {
        return { kind: "invalid", message: `memory ${a}: --project <id> is required` };
      }
      if (needsId !== (id !== null) || positional.length > 1) {
        return {
          kind: "invalid",
          message: needsId
            ? `memory ${a}: expected <memoryId>`
            : `memory ${a}: unexpected argument`,
        };
      }
      return { kind: "memory", action: a, projectId, id };
    }
    case "project-check": {
      const [projectId, ...extra] = rest;
      if (projectId === undefined || extra.length > 0 || !PROJECT_ID_PATTERN.test(projectId)) {
        return { kind: "invalid", message: "project-check: expected exactly one <projectId>" };
      }
      return { kind: "project-check", projectId };
    }
    case "eval-rescore": {
      const [evalId, ...extra] = rest;
      if (evalId === undefined || extra.length > 0 || !/^eval-\d{8}-\d{6}$/.test(evalId)) {
        return {
          kind: "invalid",
          message: "eval-rescore: expected exactly one eval id (eval-YYYYMMDD-HHMMSS)",
        };
      }
      return { kind: "eval-rescore", evalId };
    }
    case "verify-hidden": {
      const [taskId, ...extra] = rest;
      if (extra.length > 0) {
        return {
          kind: "invalid",
          message: `verify-hidden: unexpected arguments: ${extra.join(" ")}`,
        };
      }
      if (taskId !== undefined && !TASK_ID_PATTERN.test(taskId)) {
        return { kind: "invalid", message: `verify-hidden: invalid taskId "${taskId}"` };
      }
      return { kind: "verify-hidden", taskId: taskId ?? null };
    }
    case "runs": {
      const [limit, ...extra] = rest;
      if (extra.length > 0 || (limit !== undefined && !/^[1-9]\d{0,3}$/.test(limit))) {
        return { kind: "invalid", message: "runs: expected an optional positive limit" };
      }
      return { kind: "runs", limit: limit === undefined ? 20 : Number(limit) };
    }
    case "approve":
    case "reject": {
      const [runId, gate, ...flags] = rest;
      if (runId === undefined || !RUN_ID_PATTERN.test(runId) || gate !== "spec") {
        return { kind: "invalid", message: `${command}: expected <runId> spec` };
      }
      let comment: string | null = null;
      if (flags.length > 0) {
        if (flags[0] !== "--comment" || flags.length !== 2 || !flags[1]?.trim()) {
          return { kind: "invalid", message: `${command}: only --comment "<text>" is accepted` };
        }
        comment = flags[1].trim();
      }
      if (command === "reject" && comment === null) {
        return { kind: "invalid", message: 'reject: --comment "<what to change>" is required' };
      }
      return { kind: "decide", runId, gate, decision: command, comment };
    }
    case "merge":
    case "close": {
      const [runId, ...flags] = rest;
      if (runId === undefined || !RUN_ID_PATTERN.test(runId)) {
        return { kind: "invalid", message: `${command}: expected <runId>` };
      }
      let comment: string | null = null;
      if (flags.length > 0) {
        if (flags[0] !== "--comment" || flags.length !== 2 || !flags[1]?.trim()) {
          return { kind: "invalid", message: `${command}: only --comment "<text>" is accepted` };
        }
        comment = flags[1].trim();
      }
      if (command === "close" && comment === null) {
        return { kind: "invalid", message: 'close: --comment "<why not merged>" is required' };
      }
      return { kind: "decide", runId, gate: "merge", decision: command, comment };
    }
    case "eval-memory": {
      if (rest.length === 1 && (rest[0] === "verify" || rest[0] === "freeze")) {
        return { kind: "eval-memory", action: rest[0], repeat: 2, costCapUsd: null };
      }
      let repeat = 2;
      let costCapUsd: number | null = null;
      for (let k = 0; k < rest.length; k++) {
        const a = rest[k];
        if (a === "--repeat" && /^[1-5]$/.test(rest[k + 1] ?? "")) repeat = Number(rest[++k]);
        else if (a === "--cost-cap") {
          const v = Number(rest[++k]);
          if (!Number.isFinite(v) || v <= 0 || v > 100) {
            return { kind: "invalid", message: "eval-memory: --cost-cap expects USD in (0, 100]" };
          }
          costCapUsd = v;
        } else {
          return {
            kind: "invalid",
            message: "eval-memory: expected verify, freeze, --repeat 1..5 or --cost-cap USD",
          };
        }
      }
      return { kind: "eval-memory", action: "run", repeat, costCapUsd };
    }
    case "eval-review": {
      if (rest.length === 0) return { kind: "eval-review", only: null };
      if (
        rest[0] === "--only" &&
        rest.length === 2 &&
        (rest[1] === "claude-code" || rest[1] === "opencode")
      ) {
        return { kind: "eval-review", only: rest[1] };
      }
      return {
        kind: "invalid",
        message: "eval-review: only --only <claude-code|opencode> is accepted",
      };
    }
    case "reopen-merge": {
      const [runId, ...extra] = rest;
      if (runId === undefined || extra.length > 0 || !RUN_ID_PATTERN.test(runId)) {
        return { kind: "invalid", message: "reopen-merge: expected exactly one <runId>" };
      }
      return { kind: "reopen-merge", runId };
    }
    case "baseline-update": {
      if (rest[0] !== "--reason" || rest.length !== 2 || !rest[1]?.trim()) {
        return { kind: "invalid", message: 'baseline-update: --reason "<why>" is required' };
      }
      return { kind: "baseline-update", reason: rest[1].trim() };
    }
    case "resume": {
      const [runId, ...extra] = rest;
      if (runId === undefined || extra.length > 0 || !RUN_ID_PATTERN.test(runId)) {
        return {
          kind: "invalid",
          message: "resume: expected exactly one <runId> (e.g. 20261015-171000-ab12)",
        };
      }
      return { kind: "resume", runId };
    }
    case "db-import":
      if (rest.length > 0) return { kind: "invalid", message: "db-import takes no arguments" };
      return { kind: "db-import" };
    default:
      return { kind: "invalid", message: `unknown command "${command}"` };
  }
}
