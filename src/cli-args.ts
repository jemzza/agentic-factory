import { TASK_ID_PATTERN } from "./schemas/task.js";

export type CliCommand =
  | { kind: "run"; taskId: string }
  | { kind: "eval"; taskIds: string[] }
  | { kind: "verify-hidden"; taskId: string | null }
  | { kind: "runs"; limit: number }
  | { kind: "db-import" }
  | { kind: "help" }
  | { kind: "invalid"; message: string };

export const USAGE = `Usage:
  npm run run-task -- <taskId>   Run one task through Planner → Developer → Quality Gate → Reviewer
  npm run eval [-- <taskId>...]  Run the eval suite (all tasks, or the given ones) and verify
                                 successes with hidden tests
  npm run verify-hidden [-- <taskId>]
                                 Check hidden tests: fail on baseline, pass on the reference
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
      const [taskId, ...extra] = rest;
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
      return { kind: "run", taskId };
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
    case "db-import":
      if (rest.length > 0) return { kind: "invalid", message: "db-import takes no arguments" };
      return { kind: "db-import" };
    default:
      return { kind: "invalid", message: `unknown command "${command}"` };
  }
}
