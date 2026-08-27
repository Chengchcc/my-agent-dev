/** Agentic Workflow DSL domain types. Pure types — no runtime deps. */

export type NodeId = string;

/** Trigger input variable hints (light typing, not enforced). */
export type InputHint = Record<string, "string" | "number" | "boolean">;

export interface FormField {
  type: "string" | "textarea" | "number" | "enum" | "date" | "boolean";
  label?: string;
  options?: string[];
  required?: boolean;
}

/** JSONLogic rule: primitives, arrays (data), or {op: args}. */
export type JsonLogicRule =
  | string
  | number
  | boolean
  | null
  | JsonLogicRule[]
  | {
      [op: string]:
        | JsonLogicRule[]
        | string
        | boolean
        | number
        | null
        | { default?: JsonLogicRule };
    };

interface NodeCommon {
  id: NodeId;
  /** Light typing: optional input defaults; runtime merged input wins. */
  input?: Record<string, unknown>;
  /** Output type hints for editor autocomplete. */
  output?: Record<string, string>;
  retry?: number;
}

export type WorkflowNode = NodeCommon &
  (
    | { type: "start" }
    | { type: "end"; status: string }
    | { type: "agent"; agentId?: string; model?: string; prompt?: string; repo?: string }
    | { type: "script"; code: string; runtime?: "bun"; timeoutMs?: number }
    | { type: "human"; question?: string; form?: Record<string, FormField>; timeoutMs?: number }
  );

export interface EdgeDef {
  from: NodeId;
  to: NodeId;
  /** JSONLogic condition evaluated against the from-node's output + store. */
  when?: JsonLogicRule;
}

export interface WorkflowDefinition {
  version: 1;
  id: string;
  input?: InputHint;
  nodes: WorkflowNode[];
  edges: EdgeDef[];
}
