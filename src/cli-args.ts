import { TASK_ID_PATTERN } from "./schemas/task.js";

export type CliCommand =
  | { kind: "run"; taskId: string }
  | { kind: "eval" }
  | { kind: "verify-hidden"; taskId: string | null }
  | { kind: "help" }
  | { kind: "invalid"; message: string };

export const USAGE = `Usage:
  npm run run-task -- <taskId>   Run one task through Planner → Developer → Quality Gate → Reviewer
  npm run eval                   Run the full eval suite and verify results with hidden tests
  npm run verify-hidden [-- <taskId>]
                                 Check hidden tests: fail on baseline, pass on the reference`;

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
    case "eval":
      if (rest.length > 0) {
        return { kind: "invalid", message: `eval: unexpected arguments: ${rest.join(" ")}` };
      }
      return { kind: "eval" };
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
    default:
      return { kind: "invalid", message: `unknown command "${command}"` };
  }
}
