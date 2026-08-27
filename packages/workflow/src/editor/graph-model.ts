import type { WorkflowDefinition, WorkflowNode } from "../types.js";
import { layeredLayout, type PositionedNode } from "./layout.js";

export interface EditorNode extends PositionedNode {
  type: WorkflowNode["type"];
  label: string;
}

export interface EditorEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
}

function labelOf(n: WorkflowNode): string {
  switch (n.type) {
    case "start":
      return "Start";
    case "end":
      return `End: ${n.status}`;
    case "agent":
      return n.agentId ? `Agent: ${n.agentId}` : "Agent (inline)";
    case "script":
      return "Script";
    case "human":
      return n.question ? `Ask: ${n.question}` : "Ask user";
  }
}

export interface EditorGraph {
  nodes: EditorNode[];
  edges: EditorEdge[];
}

/** DSL → editor graph model (read-only render + property panel). */
export function toEditorGraph(def: WorkflowDefinition): EditorGraph {
  const nodeOf = new Map(def.nodes.map((n) => [n.id, n]));
  const nodes: EditorNode[] = layeredLayout(def).map((p) => {
    const n = nodeOf.get(p.id)!;
    return { ...p, type: n.type, label: labelOf(n) };
  });
  const edges: EditorEdge[] = def.edges.map((e, i) => ({
    id: `e${i}`,
    from: e.from,
    to: e.to,
    label: e.when === undefined ? undefined : JSON.stringify(e.when),
  }));
  return { nodes, edges };
}
