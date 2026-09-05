import type { WorkflowDefinition, WorkflowNode } from "../types.js";
import { layeredLayout, type PositionedNode } from "./layout.js";

export interface EditorNode extends PositionedNode {
  type: WorkflowNode["type"];
  label: string;
  /** Real config summary derived from the node definition (design's
   *  subtitle slot): agent model, script runtime/timeout, human question. */
  summary: string;
  /** Right-slot meta for the node footer (agent id, timeout, end status). */
  meta?: string;
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

/** Per-type config summary + footer meta, straight from the definition. */
function describeNode(n: WorkflowNode): { summary: string; meta?: string } {
  switch (n.type) {
    case "agent": {
      const summary = n.model ?? n.agentId ?? "inline agent";
      return { summary, meta: n.agentId ? `@${n.agentId}` : undefined };
    }
    case "script": {
      const lines = n.code.split("\n").filter((l) => l.trim() && !l.trim().startsWith("//"));
      const first = lines[0]?.trim().slice(0, 60) ?? "";
      return {
        summary: n.timeoutMs ? `bun · ${Math.round(n.timeoutMs / 1000)}s timeout` : "bun",
        meta: first || undefined,
      };
    }
    case "human": {
      const fields = Object.keys(n.form ?? {}).length;
      return {
        summary: n.question
          ? n.question.length > 60
            ? `${n.question.slice(0, 60)}…`
            : n.question
          : "ask user",
        meta: n.timeoutMs
          ? `${Math.round(n.timeoutMs / 1000)}s timeout`
          : `${fields} field${fields === 1 ? "" : "s"}`,
      };
    }
    case "end":
      return { summary: n.status };
    case "start":
      return { summary: "entry" };
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
    const { summary, meta } = describeNode(n);
    return { ...p, type: n.type, label: labelOf(n), summary, meta };
  });
  const edges: EditorEdge[] = def.edges.map((e, i) => ({
    id: `e${i}`,
    from: e.from,
    to: e.to,
    label: e.when === undefined ? undefined : JSON.stringify(e.when),
  }));
  return { nodes, edges };
}
