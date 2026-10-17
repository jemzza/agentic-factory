import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FACTORY_ROOT } from "../paths.js";
import type { ReviewVerdict } from "../schemas/agents.js";
import type { GateResult } from "../schemas/report.js";
import { decide, routeAfter } from "./decide.js";
import { buildGraph } from "./graph.js";
import type { NodeFn } from "./nodes.js";
import { NODE_NAMES, type NodeName, type RunStateValue } from "./state.js";

const NOW = 1_000_000;

function state(over: Partial<RunStateValue> = {}): RunStateValue {
  return {
    runId: "r",
    runDir: "/runs/r",
    mode: "interactive",
    specApprovalMode: "manual",
    repoRef: "main",
    specRaw: null,
    spec: null,
    specFiles: {},
    specValid: true,
    specIssues: [],
    specAttempts: 1,
    specCommit: "spec-commit",
    specDecision: "approve",
    specRejections: [],
    mergeDecision: null,
    mergeComment: null,
    mergeOutcome: null,
    task: {
      id: "t",
      title: "T",
      request: "r",
      acceptance_criteria: ["c"],
      scope: { allowed_paths: ["src/**"] },
      budget: {
        max_gate_fix_cycles: 2,
        max_review_cycles: 1,
        max_cost_usd: 1,
        timeout_minutes: 15,
      },
    },
    startedAtMs: NOW - 10_000,
    deadlineMs: NOW + 60_000,
    spentUsd: 0.1,
    unknownCostSteps: 0,
    repo: null,
    worktree: null,
    headCommit: null,
    conventions: "",
    planResult: { plan: "p", files_to_change: [], risks: [], questions: [] },
    cycle: 0,
    gateFixCycles: 0,
    reviewCycles: 0,
    reworks: [],
    gateResult: null,
    reviewVerdict: null,
    lastNode: "",
    lastError: null,
    status: null,
    statusMessage: "",
    steps: [],
    ...over,
  };
}

const gate = (passed: boolean): GateResult => ({
  passed,
  checks: [],
  scope: { passed: true, changedFiles: ["src/a.ts"], violations: [], empty: false },
  policyViolations: [],
});
const approve: ReviewVerdict = {
  verdict: "approve",
  issues: [],
  criteria_check: [{ criterion: "c", met: true, evidence: "e" }],
};
const reject: ReviewVerdict = { ...approve, verdict: "request_changes" };

describe("decide: transitions", () => {
  it.each<[string, Partial<RunStateValue>, NodeName]>([
    ["start", { lastNode: "" }, "prepare"],
    ["prepare", { lastNode: "prepare" }, "plan"],
    ["plan", { lastNode: "plan" }, "spec_draft"],
    ["spec_draft", { lastNode: "spec_draft" }, "spec_approval"],
    ["spec_approval", { lastNode: "spec_approval" }, "develop"],
    ["develop", { lastNode: "develop" }, "gate"],
    ["gate passed", { lastNode: "gate", gateResult: gate(true) }, "review"],
    [
      "gate failed, cycles left",
      { lastNode: "gate", gateResult: gate(false), cycle: 1, gateFixCycles: 1 },
      "develop",
    ],
    [
      "changes requested, cycles left",
      { lastNode: "review", reviewVerdict: reject, cycle: 0 },
      "develop",
    ],
  ])("%s → %s", (_name, over, next) => {
    expect(decide(state(over), NOW)).toEqual({ kind: "next", node: next });
  });

  it.each<[string, Partial<RunStateValue>, string]>([
    [
      "questions",
      {
        lastNode: "plan",
        planResult: { plan: "p", files_to_change: [], risks: [], questions: ["?"] },
      },
      "needs_clarification",
    ],
    ["approved", { lastNode: "review", reviewVerdict: approve, cycle: 1 }, "success"],
    [
      "gate failed at max",
      { lastNode: "gate", gateResult: gate(false), cycle: 2, gateFixCycles: 2 },
      "gate_failed",
    ],
    [
      "rejected at max",
      { lastNode: "review", reviewVerdict: reject, cycle: 1, reviewCycles: 1 },
      "review_rejected",
    ],
    [
      "gate failed, legacy budget",
      {
        lastNode: "gate",
        gateResult: gate(false),
        task: {
          ...state().task,
          budget: { max_fix_cycles: 2, max_cost_usd: 1, timeout_minutes: 15 },
        },
      },
      "error",
    ],
  ])("%s → stop %s", (_name, over, status) => {
    expect(decide(state(over), NOW)).toMatchObject({ kind: "stop", status });
  });
});

describe("decide: limits are enforced on edges", () => {
  it("stops before an agent node when no budget is left", () => {
    const d = decide(state({ lastNode: "gate", gateResult: gate(true), spentUsd: 1 }), NOW);
    expect(d).toMatchObject({ kind: "stop", status: "budget_exceeded" });
    expect(d.kind === "stop" && d.message).toMatch(/before reviewer/);
  });

  it("does not need budget for the non-agent gate node", () => {
    expect(decide(state({ lastNode: "develop", spentUsd: 1 }), NOW)).toEqual({
      kind: "next",
      node: "gate",
    });
  });

  it("stops as soon as spending passed the budget, even after an approval", () => {
    expect(
      decide(state({ lastNode: "review", reviewVerdict: approve, spentUsd: 1.01 }), NOW),
    ).toMatchObject({
      status: "budget_exceeded",
    });
  });

  it("times out before the next working node", () => {
    const d = decide(state({ lastNode: "develop", deadlineMs: NOW + 10 }), NOW);
    expect(d).toMatchObject({ status: "timeout" });
    expect(d.kind === "stop" && d.message).toMatch(/before quality gate/);
  });

  it("a definitive outcome wins over a passed deadline", () => {
    expect(
      decide(state({ lastNode: "review", reviewVerdict: approve, deadlineMs: NOW - 1 }), NOW),
    ).toMatchObject({
      status: "success",
    });
  });

  it("routeAfter sends every stop to report", () => {
    expect(
      routeAfter(
        state({ lastNode: "gate", gateResult: gate(false), cycle: 2, gateFixCycles: 2 }),
        NOW,
      ),
    ).toBe("report");
    expect(routeAfter(state({ lastNode: "gate", gateResult: gate(true) }), NOW)).toBe("review");
  });
});

describe("decide: node errors", () => {
  it.each([
    ["timeout", "timeout", /^developer: /],
    ["budget", "budget_exceeded", /^developer: /],
    ["infra", "infra_error", /^provider unavailable in developer: /],
    ["process", "error", /^process error in developer: /],
    ["invalid_response", "error", /^invalid_response error in developer: /],
    ["sandbox", "error", /^sandbox failure: /],
    ["exception", "error", /^unexpected error: /],
  ] as const)("%s → %s", (kind, status, message) => {
    const d = decide(
      state({ lastNode: "develop", lastError: { node: "develop", kind, message: "boom" } }),
      NOW,
    );
    expect(d).toMatchObject({ kind: "stop", status });
    expect(d.kind === "stop" && d.message).toMatch(message);
  });
});

describe("graph structure", () => {
  it("has exactly the nodes and edges documented in docs/graph.md", async () => {
    const noop: NodeFn = () => Promise.resolve({});
    const nodes = Object.fromEntries(NODE_NAMES.map((n) => [n, noop])) as Record<NodeName, NodeFn>;
    const g = await buildGraph(nodes, { deadlineNow: () => NOW }).getGraphAsync();
    expect(Object.keys(g.nodes).sort()).toEqual(["__end__", "__start__", ...NODE_NAMES].sort());
    const edges = g.edges.map((e) => `${e.source}->${e.target}`).sort();
    expect(edges).toEqual(
      [
        "__start__->prepare",
        "prepare->plan",
        "prepare->report",
        "plan->spec_draft",
        "plan->report",
        "spec_draft->spec_approval",
        "spec_draft->spec_draft",
        "spec_draft->report",
        "spec_approval->develop",
        "spec_approval->plan",
        "spec_approval->report",
        "develop->gate",
        "develop->report",
        "gate->review",
        "gate->develop",
        "gate->report",
        "review->develop",
        "review->report",
        "report->merge_approval",
        "report->__end__",
        "merge_approval->merge",
        "merge_approval->close",
        "merge->merge_approval",
        "merge->__end__",
        "close->__end__",
      ].sort(),
    );
    // Every node of the graph appears in the Mermaid diagram.
    const doc = readFileSync(path.join(FACTORY_ROOT, "docs", "graph.md"), "utf8");
    for (const name of NODE_NAMES) expect(doc).toContain(name);
  });
});
