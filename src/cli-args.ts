import { TASK_ID_PATTERN } from "./schemas/task.js";

export const RUN_ID_PATTERN = /^\d{8}-\d{6}-[0-9a-f]{4}$/;

export type CliCommand =
  | { kind: "run"; taskId: string; autoApproveSpec: boolean }
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
  | { kind: "eval"; taskIds: string[] }
  | { kind: "verify-hidden"; taskId: string | null }
  | { kind: "runs"; limit: number }
  | { kind: "resume"; runId: string }
  | { kind: "db-import" }
  | { kind: "help" }
  | { kind: "invalid"; message: string };

export const USAGE = `Usage:
  npm run run-task -- <taskId> [--auto-approve-spec]
                                 Run one task; stops for spec approval unless --auto-approve-spec
  npm run approve -- <runId> spec
  npm run reject -- <runId> spec --comment "..."
                                 Approve the OpenSpec change, or send it back to planning
  npm run merge -- <runId>       Merge a successful run into main (gate re-runs on the merge result)
  npm run close -- <runId> --comment "..."
                                 Close a successful run without merging
  npm run eval:review [-- --only <claude-code|opencode>]
                                 Compare reviewers on evals/review/ (recall, false positive rate)
  npm run reopen-merge -- <runId> One-time: put a success run from before the merge gate at it
  npm run baseline:update -- --reason "..."
                                 Move the factory-baseline tag to main (recorded in the DB)
  npm run eval [-- <taskId>...]  Run the eval suite (all tasks, or the given ones) and verify
                                 successes with hidden tests
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
      const autoApproveSpec = rest.includes("--auto-approve-spec");
      const [taskId, ...extra] = rest.filter((a) => a !== "--auto-approve-spec");
      if (taskId === undefined) return { kind: "invalid", message: "run: missing <taskId>" };
      if (!TASK_ID_PATTERN.test(taskId)) {
        return {
          kind: "invalid",
          message: `run: invalid taskId "${taskId}" (expected kebab-case)`,
        };
      }
      if (extra.length > 0) {
        return { kind: "invalid", message: `run: unexpected arguments: ${extra.join(" ")}` };
      }
      return { kind: "run", taskId, autoApproveSpec };
    }
    case "eval": {
      const bad = rest.filter((id) => !TASK_ID_PATTERN.test(id));
      if (bad.length > 0) {
        return { kind: "invalid", message: `eval: invalid taskId(s): ${bad.join(" ")}` };
      }
      return { kind: "eval", taskIds: [...new Set(rest)] };
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
