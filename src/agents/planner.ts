import { plannerJsonSchema, PlannerOutputSchema, type PlannerOutput } from "../schemas/agents.js";
import type { TaskSpec } from "../schemas/task.js";
import type { AgentRunResult } from "../runtimes/types.js";
import { renderTask } from "./prompts.js";
import { parseStructured, type StructuredOutcome } from "./structured.js";

export const PLANNER_OUTPUT_SCHEMA = plannerJsonSchema;

export function plannerPrompt(task: TaskSpec): string {
  return [
    renderTask(task),
    "Explore the repository, then return your plan (or blocking questions) as JSON.",
  ].join("\n\n");
}

export function parsePlannerResult(result: AgentRunResult): StructuredOutcome<PlannerOutput> {
  return parseStructured(result, PlannerOutputSchema);
}
