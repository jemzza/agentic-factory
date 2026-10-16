import { isApproved } from "../agents/reviewer.js";
import type { RunStatus } from "../schemas/report.js";
import { describeIssues } from "../spec/openspec.js";
import {
  MAX_SPEC_ATTEMPTS,
  MAX_SPEC_REJECTIONS,
  type NodeName,
  type RunStateValue,
  type StepError,
} from "./state.js";

export type Decision =
  { kind: "next"; node: NodeName } | { kind: "stop"; status: RunStatus; message: string };

/** Minimum time left to start a step; below it the task times out instead. */
export const MIN_STEP_MS = 1_000;

const AGENT_NODES: Partial<Record<NodeName, "planner" | "developer" | "reviewer">> = {
  plan: "planner",
  develop: "developer",
  review: "reviewer",
};

const stop = (status: RunStatus, message: string): Decision => ({ kind: "stop", status, message });

/** Maps a node error to a final status (same wording as the Week 1 pipeline). */
export function stopForError(error: StepError): Decision {
  const role = AGENT_NODES[error.node as NodeName] ?? error.node;
  const detail = `${role}: ${error.message}`;
  switch (error.kind) {
    case "timeout":
      return stop("timeout", detail);
    case "budget":
      return stop("budget_exceeded", detail);
    case "sandbox":
      return stop("error", `sandbox failure: ${error.message}`);
    case "exception":
      return stop("error", `unexpected error: ${error.message}`);
    case "process":
    case "parse":
    case "invalid_response":
      return stop("error", `${error.kind} error in ${detail}`);
  }
}

/**
 * Limits are enforced here, on the edge into a node: no budget left before an agent call,
 * or not enough time left before any working node.
 */
function guarded(s: RunStateValue, node: NodeName, nowMs: number): Decision {
  const budget = s.task.budget.max_cost_usd;
  const role = AGENT_NODES[node];
  if (role && budget - s.spentUsd <= 0) {
    return stop(
      "budget_exceeded",
      `budget $${budget} spent before ${role} (cycle ${Math.max(0, node === "develop" ? s.cycle + 1 : s.cycle)})`,
    );
  }
  if (node !== "report" && s.deadlineMs - nowMs < MIN_STEP_MS) {
    const what = node === "gate" ? "quality gate" : (role ?? node);
    return stop(
      "timeout",
      `task timeout (${s.task.budget.timeout_minutes} min) reached before ${what}`,
    );
  }
  return { kind: "next", node };
}

/**
 * The single routing rule of the workflow. Conditional edges call it to pick the next node;
 * the `report` node calls it again to record the final status, so no rule is duplicated.
 * Definitive outcomes (errors, success, exhausted fix cycles) are decided before limits.
 */
export function decide(s: RunStateValue, nowMs: number): Decision {
  if (s.lastError) return stopForError(s.lastError);
  const budget = s.task.budget.max_cost_usd;
  if (s.spentUsd > budget) {
    return stop(
      "budget_exceeded",
      `spent $${s.spentUsd.toFixed(4)} > budget $${budget} after ${AGENT_NODES[s.lastNode as NodeName] ?? s.lastNode}`,
    );
  }
  const maxCycles = s.task.budget.max_fix_cycles;

  switch (s.lastNode as NodeName | "") {
    case "":
      return { kind: "next", node: "prepare" };
    case "prepare":
      return guarded(s, "plan", nowMs);
    case "plan":
      if (!s.planResult) return stop("error", "planner produced no plan");
      if (s.planResult.questions.length > 0) {
        return stop(
          "needs_clarification",
          `planner asked ${s.planResult.questions.length} question(s)`,
        );
      }
      return guarded(s, "spec_draft", nowMs);
    case "spec_draft":
      if (s.specValid) return { kind: "next", node: "spec_approval" };
      if (s.specAttempts < MAX_SPEC_ATTEMPTS) {
        // The retry asks the Planner to fix the spec: an agent call, so the budget applies.
        if (budget - s.spentUsd <= 0) {
          return stop("budget_exceeded", `budget $${budget} spent before planner (spec fix)`);
        }
        return guarded(s, "spec_draft", nowMs);
      }
      return stop(
        "error",
        `OpenSpec validation failed after ${s.specAttempts} attempt(s):\n${describeIssues(s.specIssues)}`,
      );
    case "spec_approval":
      if (s.specDecision === "approve") return guarded(s, "develop", nowMs);
      if (s.specDecision === "reject") {
        if (s.specRejections.length <= MAX_SPEC_REJECTIONS) return guarded(s, "plan", nowMs);
        return stop(
          "needs_clarification",
          `specification rejected ${s.specRejections.length} times; a human needs to clarify the task`,
        );
      }
      return stop("error", "spec approval produced no decision");
    case "develop":
      return guarded(s, "gate", nowMs);
    case "gate":
      if (!s.gateResult) return stop("error", "quality gate produced no result");
      if (s.gateResult.passed) return guarded(s, "review", nowMs);
      if (s.cycle >= maxCycles) {
        return stop("gate_failed", `quality gate still failing after ${s.cycle} fix cycle(s)`);
      }
      return guarded(s, "develop", nowMs);
    case "review":
      if (!s.reviewVerdict) return stop("error", "reviewer produced no verdict");
      if (isApproved(s.reviewVerdict)) {
        return stop("success", `gate passed and reviewer approved after ${s.cycle} fix cycle(s)`);
      }
      if (s.cycle >= maxCycles) {
        return stop("review_rejected", `reviewer did not approve after ${s.cycle} fix cycle(s)`);
      }
      return guarded(s, "develop", nowMs);
    case "report":
      return s.status ? stop(s.status, s.statusMessage) : stop("error", "report without status");
    default:
      return stop("error", `unknown node "${s.lastNode}"`);
  }
}

/** Conditional-edge adapter: the next node, or `report` when the run must stop. */
export function routeAfter(s: RunStateValue, nowMs: number): NodeName {
  const d = decide(s, nowMs);
  return d.kind === "next" ? d.node : "report";
}
