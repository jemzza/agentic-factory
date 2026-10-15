import { END, START, StateGraph, type BaseCheckpointSaver } from "@langchain/langgraph";
import { routeAfter } from "./decide.js";
import type { NodeFn } from "./nodes.js";
import { RunState, type NodeName } from "./state.js";

/**
 * Workflow wiring only (see docs/graph.md). Nodes come from `makeNodes`; every transition
 * after a working node goes through `routeAfter`, which applies the limits and picks the
 * next node or `report`. No business logic lives here.
 */
export function buildGraph(
  nodes: Record<NodeName, NodeFn>,
  opts: { now: () => Date; checkpointer?: BaseCheckpointSaver },
) {
  const route = (s: typeof RunState.State) => routeAfter(s, opts.now().getTime());
  const targets = (...names: NodeName[]) => names;

  const graph = new StateGraph(RunState)
    .addNode("prepare", nodes.prepare)
    .addNode("plan", nodes.plan)
    .addNode("spec_draft", nodes.spec_draft)
    .addNode("spec_approval", nodes.spec_approval)
    .addNode("develop", nodes.develop)
    .addNode("gate", nodes.gate)
    .addNode("review", nodes.review)
    .addNode("report", nodes.report)
    .addEdge(START, "prepare")
    .addConditionalEdges("prepare", route, targets("plan", "report"))
    .addConditionalEdges("plan", route, targets("spec_draft", "report"))
    .addConditionalEdges("spec_draft", route, targets("spec_approval", "report"))
    .addConditionalEdges("spec_approval", route, targets("develop", "report"))
    .addConditionalEdges("develop", route, targets("gate", "report"))
    .addConditionalEdges("gate", route, targets("review", "develop", "report"))
    .addConditionalEdges("review", route, targets("develop", "report"))
    .addEdge("report", END);

  return graph.compile(opts.checkpointer ? { checkpointer: opts.checkpointer } : {});
}
