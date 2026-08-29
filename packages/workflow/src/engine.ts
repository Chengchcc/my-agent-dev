import { type CompletionRecord, mergeInputs } from "./graph.js";
import type { WorkflowDefinition, WorkflowNode } from "./types.js";

export interface EngineState {
  /** Completed nodes in completion order. */
  completions: CompletionRecord[];
  store: Record<string, unknown>;
  trigger: Record<string, unknown>;
}

export interface ReadyRun {
  node: WorkflowNode;
  input: Record<string, unknown>;
  provenance: Record<string, string>;
}

export type EngineStep =
  | { kind: "run"; ready: ReadyRun[] }
  | { kind: "terminal"; exit: string }
  | { kind: "idle" };

/** Pure execution core: given a definition and state, decide what runs next.
 *  Routing comes from CompletionRecord.routedTo (frozen at completion time) — never recomputed. */
export function computeNext(def: WorkflowDefinition, state: EngineState): EngineStep {
  const nodeOf = new Map(def.nodes.map((n) => [n.id, n]));
  const completedIds = new Set(state.completions.map((c) => c.nodeId));

  const routed = new Map<string, Set<string>>();
  for (const c of state.completions) routed.set(c.nodeId, new Set(c.routedTo));

  const readyIds: string[] = [];
  if (state.completions.length === 0) {
    const start = def.nodes.find((n) => n.type === "start");
    if (!start) throw new Error("workflow has no start node");
    readyIds.push(start.id);
  } else {
    for (const n of def.nodes) {
      if (completedIds.has(n.id)) continue;
      const inEdges = def.edges.filter((e) => e.to === n.id);
      if (inEdges.length === 0) continue; // start already handled
      if (inEdges.every((e) => routed.get(e.from)?.has(n.id))) readyIds.push(n.id);
    }
  }

  const ends = readyIds.map((id) => nodeOf.get(id)!).filter((n) => n.type === "end");
  if (ends.length > 0) {
    const first = ends[0]!;
    if (first.type === "end") return { kind: "terminal", exit: first.status };
  }
  if (readyIds.length === 0) return { kind: "idle" };

  const ready: ReadyRun[] = readyIds.map((id) => {
    const node = nodeOf.get(id)!;
    const { input, provenance } = mergeInputs(state.completions, state.store, state.trigger);
    return { node, input: { ...input }, provenance };
  });
  return { kind: "run", ready };
}
