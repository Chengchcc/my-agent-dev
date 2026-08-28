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

/** JSON Schema subset for node input/output validation (see schema.ts). */
export interface JsonSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
}

export interface ArtifactRef {
  url: string;
  /** Default true — missing fails the node. false = warning only. */
  required?: boolean;
}

interface NodeCommon {
  id: NodeId;
  /** Light typing: optional input defaults; runtime merged input wins. */
  input?: Record<string, unknown>;
  /** Output type hints for editor autocomplete. */
  output?: Record<string, string>;
  /** Optional JSON-Schema-subset validation for merged input (fail node on violation). */
  inputSchema?: JsonSchema;
  /** Optional JSON-Schema-subset validation for node output (fail node on violation). */
  outputSchema?: JsonSchema;
  /** Retry policy: number = max retries after first failure, or a config
   *  with attempts/interval/backoff. */
  retry?: number | NodeRetry;
  /** Artifacts this node consumes (must exist before execution).
   *  Default required=true. */
  inputArtifacts?: ArtifactRef[];
  /** Artifacts this node must produce (must exist after execution).
   *  Default required=true. */
  outputArtifacts?: ArtifactRef[];
}

export interface NodeRetry {
  /** Max retries after the first failure (default 0 = no retry). */
  maxAttempts?: number;
  /** Base delay between retries in ms (default 0). */
  intervalMs?: number;
  /** Exponential backoff multiplier per retry (default 1 = constant). */
  backoff?: number;
}

export type WorkflowNode = NodeCommon &
  (
    | { type: "start" }
    | { type: "end"; status: string }
    | { type: "agent"; agentId?: string; model?: string; prompt?: string; repo?: string }
    | { type: "script"; code: string; runtime?: "bun"; timeoutMs?: number }
    | { type: "human"; question?: string; form?: Record<string, FormField>; timeoutMs?: number }
  );

export interface WorkflowMeta {
  name?: string;
  description?: string;
  tags?: string[];
  status?: "draft" | "active" | "archived";
  owner?: string;
  updatedBy?: string;
}

export interface EdgeDef {
  from: NodeId;
  to: NodeId;
  /** JSONLogic condition evaluated against the from-node's output + store. */
  when?: JsonLogicRule;
}

export interface CronTrigger {
  type: "cron";
  /** 5-field cron expression, UTC. */
  cron: string;
  enabled?: boolean;
}
export type WorkflowTrigger = CronTrigger;

export interface WorkflowDefinition {
  version: 1;
  id: string;
  meta?: WorkflowMeta;
  input?: InputHint;
  /** Trigger declarations. API trigger is implicit. */
  triggers?: WorkflowTrigger[];
  /** Workflow-run required artifacts (must exist at start). */
  inputArtifacts?: ArtifactRef[];
  nodes: WorkflowNode[];
  edges: EdgeDef[];
}
