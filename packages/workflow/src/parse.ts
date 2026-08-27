import { topoSort } from "./graph.js";
import type {
  FormField,
  InputHint,
  JsonLogicRule,
  JsonSchema,
  WorkflowDefinition,
  WorkflowNode,
} from "./types.js";

export class WorkflowParseError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(issues.join("; "));
    this.name = "WorkflowParseError";
    this.issues = issues;
  }
}

const NODE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const NODE_TYPES: Record<string, true> = {
  start: true,
  end: true,
  agent: true,
  script: true,
  human: true,
};
const FIELD_TYPES: Record<string, true> = {
  string: true,
  textarea: true,
  number: true,
  enum: true,
  date: true,
  boolean: true,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown, label: string, issues: string[]): string | undefined {
  if (typeof v !== "string" || v.trim() === "") {
    issues.push(`${label} must be a non-empty string`);
    return undefined;
  }
  return v;
}

function parseField(name: string, raw: unknown, issues: string[]): FormField | undefined {
  if (!isRecord(raw)) {
    issues.push(`form.${name} must be an object`);
    return undefined;
  }
  if (typeof raw.type !== "string" || FIELD_TYPES[raw.type] !== true) {
    issues.push(`form.${name}.type must be one of ${Object.keys(FIELD_TYPES).join("/")}`);
    return undefined;
  }
  const field: FormField = { type: raw.type as FormField["type"] };
  if (typeof raw.label === "string") field.label = raw.label;
  if (typeof raw.required === "boolean") field.required = raw.required;
  if (Array.isArray(raw.options) && raw.options.every((o) => typeof o === "string"))
    field.options = raw.options;
  return field;
}

function parseNode(raw: unknown, issues: string[]): WorkflowNode | undefined {
  if (!isRecord(raw)) {
    issues.push("node must be an object");
    return undefined;
  }
  const id = nonEmptyString(raw.id, "node.id", issues);
  if (id && !NODE_ID_RE.test(id))
    issues.push(`node.id "${id}" contains invalid characters (use [a-zA-Z0-9_-])`);
  if (typeof raw.type !== "string" || NODE_TYPES[raw.type] !== true) {
    issues.push(`node "${id ?? "?"}" has unknown type ${String(raw.type)}`);
    return undefined;
  }
  const node: Record<string, unknown> & { id: string; type: WorkflowNode["type"] } = {
    id: id ?? "",
    type: raw.type as WorkflowNode["type"],
  };
  if (isRecord(raw.input)) node.input = raw.input;
  if (isRecord(raw.output)) node.output = raw.output;
  if (isRecord(raw.inputSchema)) node.inputSchema = raw.inputSchema as JsonSchema;
  if (isRecord(raw.outputSchema)) node.outputSchema = raw.outputSchema as JsonSchema;
  if (typeof raw.retry === "number" && Number.isInteger(raw.retry) && raw.retry >= 0)
    node.retry = raw.retry;
  switch (raw.type) {
    case "end": {
      const status = nonEmptyString(raw.status, `node "${id}" status`, issues);
      if (status) node.status = status;
      break;
    }
    case "agent": {
      const agentId =
        typeof raw.agentId === "string" && raw.agentId.trim() !== "" ? raw.agentId : undefined;
      const model =
        typeof raw.model === "string" && raw.model.trim() !== "" ? raw.model : undefined;
      const prompt =
        typeof raw.prompt === "string" && raw.prompt.trim() !== "" ? raw.prompt : undefined;
      if (!agentId && !(model && prompt))
        issues.push(`node "${id}" agent requires agentId or both model+prompt`);
      if (agentId) node.agentId = agentId;
      if (model) node.model = model;
      if (prompt) node.prompt = prompt;
      if (typeof raw.repo === "string" && raw.repo.trim() !== "") node.repo = raw.repo;
      break;
    }
    case "script": {
      const code = nonEmptyString(raw.code, `node "${id}" code`, issues);
      if (code) node.code = code;
      if (raw.runtime === "bun") node.runtime = "bun";
      if (typeof raw.timeoutMs === "number" && raw.timeoutMs > 0) node.timeoutMs = raw.timeoutMs;
      break;
    }
    case "human": {
      if (typeof raw.question === "string" && raw.question.trim() !== "")
        node.question = raw.question;
      if (isRecord(raw.form)) {
        const form: Record<string, FormField> = {};
        for (const [k, v] of Object.entries(raw.form)) {
          const field = parseField(k, v, issues);
          if (field) form[k] = field;
        }
        node.form = form;
      }
      if (typeof raw.timeoutMs === "number" && raw.timeoutMs > 0) node.timeoutMs = raw.timeoutMs;
      break;
    }
    case "start":
      break;
  }
  return node as WorkflowNode;
}

export function parseWorkflow(raw: unknown): WorkflowDefinition {
  const issues: string[] = [];
  if (!isRecord(raw)) throw new WorkflowParseError(["workflow must be an object"]);
  if (raw.version !== 1) throw new WorkflowParseError(["version must be 1"]);
  const id = nonEmptyString(raw.id, "id", issues);
  const nodes: WorkflowNode[] = [];
  if (Array.isArray(raw.nodes) && raw.nodes.length > 0) {
    for (const n of raw.nodes) {
      const parsed = parseNode(n, issues);
      if (parsed) nodes.push(parsed);
    }
  } else {
    issues.push("nodes must be a non-empty array");
  }
  const seen = new Set<string>();
  for (const n of nodes) {
    if (seen.has(n.id)) issues.push(`duplicate node id "${n.id}"`);
    seen.add(n.id);
  }
  const starts = nodes.filter((n) => n.type === "start");
  if (starts.length !== 1) issues.push(`expected exactly one start node, found ${starts.length}`);
  const edges: WorkflowDefinition["edges"] = [];
  if (Array.isArray(raw.edges)) {
    for (const e of raw.edges) {
      if (!isRecord(e)) {
        issues.push("edge must be an object");
        continue;
      }
      const from = nonEmptyString(e.from, "edge.from", issues);
      const to = nonEmptyString(e.to, "edge.to", issues);
      if (from && to)
        edges.push({
          from,
          to,
          when: e.when === null ? undefined : (e.when as JsonLogicRule | undefined),
        });
    }
  } else {
    issues.push("edges must be an array");
  }
  for (const e of edges) {
    if (!seen.has(e.from)) issues.push(`edge.from "${e.from}" is not a node id`);
    if (!seen.has(e.to)) issues.push(`edge.to "${e.to}" is not a node id`);
  }
  const input: InputHint = {};
  if (raw.input !== undefined) {
    if (!isRecord(raw.input)) issues.push("input must be an object");
    else {
      for (const [k, v] of Object.entries(raw.input)) {
        if (v !== "string" && v !== "number" && v !== "boolean")
          issues.push(`input.${k} must be string/number/boolean hint`);
        else input[k] = v;
      }
    }
  }
  const meta: WorkflowMeta = {};
  if (raw.meta !== undefined) {
    if (!isRecord(raw.meta)) issues.push("meta must be an object");
    else {
      if (typeof raw.meta.name === "string") meta.name = raw.meta.name;
      if (typeof raw.meta.description === "string") meta.description = raw.meta.description;
      if (typeof raw.meta.owner === "string") meta.owner = raw.meta.owner;
      if (typeof raw.meta.updatedBy === "string") meta.updatedBy = raw.meta.updatedBy;
      if (Array.isArray(raw.meta.tags) && raw.meta.tags.every((t) => typeof t === "string")) meta.tags = raw.meta.tags;
      if (raw.meta.status === "draft" || raw.meta.status === "active" || raw.meta.status === "archived") meta.status = raw.meta.status;
    }
  }
  if (issues.length > 0) throw new WorkflowParseError(issues);
  const def: WorkflowDefinition = { version: 1, id: id!, nodes, edges };
  if (Object.keys(input).length > 0) def.input = input;
  if (Object.keys(meta).length > 0) def.meta = meta;
  topoSort(def); // throws GraphCycleError on cycle
  return def;
}
