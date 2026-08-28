import { evalJsonLogic } from "./json-logic.js";
import type { JsonLogicRule, WorkflowDefinition } from "./types.js";

export interface CompletionRecord {
  nodeId: string;
  output?: Record<string, unknown>;
  /** Completion order index (0-based) for global merge. */
  order: number;
  /** Targets routed at completion time (frozen — later store writes cannot flip). */
  routedTo: string[];
}

export class GraphCycleError extends Error {
  constructor() {
    super("cycle detected in workflow graph");
    this.name = "GraphCycleError";
  }
}

export class WorkflowRouteError extends Error {
  constructor(nodeId: string, nextNode: string) {
    super(`node "${nodeId}" nextNode "${nextNode}" is not an edge target`);
    this.name = "WorkflowRouteError";
  }
}

/** Kahn topological sort; throws GraphCycleError on cycle. */
export function topoSort(def: WorkflowDefinition): string[] {
  const indeg = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const n of def.nodes) indeg.set(n.id, 0);
  for (const e of def.edges) {
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    const list = out.get(e.from) ?? [];
    list.push(e.to);
    out.set(e.from, list);
  }
  const queue = def.nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const result: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    result.push(id);
    for (const t of out.get(id) ?? []) {
      indeg.set(t, (indeg.get(t) ?? 1) - 1);
      if ((indeg.get(t) ?? 0) === 0) queue.push(t);
    }
  }
  if (result.length !== def.nodes.length) throw new GraphCycleError();
  return result;
}

function evalData(
  nodeId: string,
  output: Record<string, unknown> | undefined,
  store: Record<string, unknown>,
): unknown {
  return { store, [nodeId]: { output } };
}

/** Compute a completed node's routed targets at completion time.
 *  Truthy `when` edges (or unconditional), plus nextNode override.
 *  The shell stores the result into CompletionRecord.routedTo — never recompute later. */
export function routeOutgoing(
  nodeId: string,
  def: WorkflowDefinition,
  completions: CompletionRecord[],
  store: Record<string, unknown>,
  /** The completed node's own output. Pass explicitly at completion time —
   *  if omitted, the implementation falls back to finding it in `completions`. */
  sourceOutput?: Record<string, unknown>,
): string[] {
  const out = sourceOutput ?? completions.find((c) => c.nodeId === nodeId)?.output;
  const override = typeof out?.nextNode === "string" ? (out.nextNode as string) : undefined;
  const edges = def.edges.filter((e) => e.from === nodeId);
  if (override !== undefined) {
    if (!edges.some((e) => e.to === override)) throw new WorkflowRouteError(nodeId, override);
    return [override];
  }
  const data = evalData(nodeId, out, store);
  return edges
    .filter((e) => e.when === undefined || Boolean(evalJsonLogic(e.when as JsonLogicRule, data)))
    .map((e) => e.to);
}

export interface MergeResult {
  input: Record<string, unknown>;
  /** key → winning nodeId ("trigger"/"store" for those planes). */
  provenance: Record<string, string>;
}

/** Global merge: trigger vars, then store, then ALL completed outputs in completion order (later wins). */
export function mergeInputs(
  completions: CompletionRecord[],
  store: Record<string, unknown>,
  trigger: Record<string, unknown>,
): MergeResult {
  const input: Record<string, unknown> = { ...trigger };
  const provenance: Record<string, string> = {};
  for (const [k] of Object.entries(trigger)) provenance[k] = "trigger";
  for (const [k, v] of Object.entries(store)) {
    input[k] = v;
    provenance[k] = "store";
  }
  for (const c of [...completions].sort((a, b) => a.order - b.order)) {
    if (!c.output) continue;
    for (const [k, v] of Object.entries(c.output)) {
      if (k === "nextNode") continue; // control field, not data
      input[k] = v;
      provenance[k] = c.nodeId;
    }
  }
  return { input, provenance };
}
