import { topoSort } from "./graph.js";
import type {
  FormField,
  InputHint,
  JsonLogicRule,
  JsonSchema,
  NodeRetry,
  WorkflowDefinition,
  WorkflowMeta,
  WorkflowNode,
  WorkflowTrigger,
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
  const nodeInput = parseInputHint(raw.input, `node "${id}" input`, issues);
  if (nodeInput !== undefined) node.input = nodeInput;
  const nodeOutput = parseInputHint(raw.output, `node "${id}" output`, issues);
  if (nodeOutput !== undefined) node.output = nodeOutput;
  if (isRecord(raw.inputSchema)) node.inputSchema = raw.inputSchema as JsonSchema;
  if (isRecord(raw.outputSchema)) node.outputSchema = raw.outputSchema as JsonSchema;
  if (typeof raw.retry === "number" && Number.isInteger(raw.retry) && raw.retry >= 0)
    node.retry = raw.retry;
  else if (isRecord(raw.retry)) {
    const cfg: Record<string, unknown> = {};
    if (
      typeof raw.retry.maxAttempts === "number" &&
      Number.isInteger(raw.retry.maxAttempts) &&
      raw.retry.maxAttempts >= 0
    )
      cfg.maxAttempts = raw.retry.maxAttempts;
    if (typeof raw.retry.intervalMs === "number" && raw.retry.intervalMs >= 0)
      cfg.intervalMs = raw.retry.intervalMs;
    if (typeof raw.retry.backoff === "number" && raw.retry.backoff >= 1)
      cfg.backoff = raw.retry.backoff;
    if (Object.keys(cfg).length > 0) node.retry = cfg as NodeRetry;
  }
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

function parseInputHint(raw: unknown, label: string, issues: string[]): InputHint | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    issues.push(`${label} must be an array of { key, type }`);
    return undefined;
  }
  const out: InputHint = [];
  for (const [i, item] of raw.entries()) {
    if (typeof item !== "object" || item === null) {
      issues.push(`${label}[${i}] must be an object`);
      continue;
    }
    const o = item as Record<string, unknown>;
    if (typeof o.key !== "string" || o.key.trim() === "") {
      issues.push(`${label}[${i}].key must be a non-empty string`);
      continue;
    }
    const type = o.type;
    if (type !== "string" && type !== "number" && type !== "boolean" && type !== "artifact") {
      issues.push(`${label}[${i}].type must be string/number/boolean/artifact`);
      continue;
    }
    out.push({ key: o.key, type });
  }
  return out;
}

/** Collect every JSONLogic `var` path in a rule (e.g. `approve.output.approve`).
 *  Walks arrays + single-key objects; skips plain-value leaves. */
function collectVarPaths(rule: unknown, out: string[] = []): string[] {
  if (Array.isArray(rule)) {
    for (const item of rule) collectVarPaths(item, out);
    return out;
  }
  if (!isRecord(rule)) return out;
  const entries = Object.entries(rule);
  if (entries.length === 1 && entries[0]![0] === "var") {
    const rawArgs = entries[0]![1];
    if (typeof rawArgs === "string") out.push(rawArgs);
    else if (Array.isArray(rawArgs) && typeof rawArgs[0] === "string") out.push(rawArgs[0]);
    return out;
  }
  for (const [, v] of entries) collectVarPaths(v, out);
  return out;
}

/** The set of top-level output field names a node exposes to downstream
 *  `node.output.<field>` references. Human gates expose their form field
 *  names (the answers are flattened to `output[id]`); script/agent expose
 *  their declared `output` hint keys; start/end expose none. */
function nodeOutputFields(node: WorkflowNode): Set<string> {
  if (node.type === "human" && node.form) return new Set(Object.keys(node.form));
  if ((node.type === "script" || node.type === "agent") && node.output)
    return new Set(node.output.map((f) => f.key));
  return new Set();
}

/** Nodes reachable from a single start via the edge graph. A dangling node
 *  (no in-edge, no path from start) never runs — surface it at parse time. */
function reachableNodes(nodes: WorkflowNode[], edges: WorkflowDefinition["edges"]): Set<string> {
  const reachable = new Set<string>();
  const start = nodes.find((n) => n.type === "start");
  if (!start) return reachable;
  const queue = [start.id];
  reachable.add(start.id);
  while (queue.length > 0) {
    const cur = queue.pop()!;
    for (const e of edges) {
      if (e.from === cur && !reachable.has(e.to)) {
        reachable.add(e.to);
        queue.push(e.to);
      }
    }
  }
  return reachable;
}

/** Validate the edges' `when` JSONLogic `var` references against the output
 *  fields of the referenced node. Catches routes that reference fields the
 *  node doesn't produce (e.g. a typo, or a missing human form field) — the
 *  runtime would otherwise evaluate false forever and deadlock. */
function validateEdgeWhen(
  edges: WorkflowDefinition["edges"],
  nodeById: Map<string, WorkflowNode>,
  issues: string[],
): void {
  for (const e of edges) {
    if (e.when === undefined) continue;
    for (const path of collectVarPaths(e.when)) {
      const m = /^([A-Za-z0-9_-]+)\.output\.([A-Za-z0-9_-]+)$/.exec(path);
      if (!m) continue; // store. / input. / trigger. / node.results.* — dynamic, skip
      const nodeId = m[1]!;
      const field = m[2]!;
      const node = nodeById.get(nodeId);
      if (!node) {
        issues.push(`edge "${e.from}->${e.to}" references unknown node "${nodeId}"`);
        continue;
      }
      const fields = nodeOutputFields(node);
      if (fields.size > 0 && !fields.has(field)) {
        issues.push(
          `edge "${e.from}->${e.to}" when ${path}: node "${nodeId}" has no output field "${field}"`,
        );
      }
    }
  }
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
  // A node with no path from start never runs (its edges still exist but no
  // completion will ever reach it) — flag dangling nodes so the author fixes
  // the topology instead of shipping a dead branch.
  const reachable = reachableNodes(nodes, edges);
  for (const n of nodes) {
    if (n.type !== "start" && !reachable.has(n.id))
      issues.push(`node "${n.id}" is not reachable from start (no incoming path)`);
  }
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  validateEdgeWhen(edges, nodeById, issues);
  const parsedWfInput = parseInputHint(raw.input, "input", issues);
  const input: InputHint = parsedWfInput ?? [];
  const meta: WorkflowMeta = {};
  if (raw.meta !== undefined) {
    if (!isRecord(raw.meta)) issues.push("meta must be an object");
    else {
      if (typeof raw.meta.name === "string") meta.name = raw.meta.name;
      if (typeof raw.meta.description === "string") meta.description = raw.meta.description;
      if (typeof raw.meta.owner === "string") meta.owner = raw.meta.owner;
      if (typeof raw.meta.updatedBy === "string") meta.updatedBy = raw.meta.updatedBy;
      if (Array.isArray(raw.meta.tags) && raw.meta.tags.every((t) => typeof t === "string"))
        meta.tags = raw.meta.tags;
      if (
        raw.meta.status === "draft" ||
        raw.meta.status === "active" ||
        raw.meta.status === "archived"
      )
        meta.status = raw.meta.status;
    }
  }
  if (issues.length > 0) throw new WorkflowParseError(issues);
  const triggers: WorkflowTrigger[] = [];
  if (raw.triggers !== undefined) {
    if (!Array.isArray(raw.triggers)) issues.push("triggers must be an array");
    else {
      for (const [i, t] of raw.triggers.entries()) {
        if (typeof t !== "object" || t === null) {
          issues.push(`triggers[${i}] must be an object`);
          continue;
        }
        const tr = t as Record<string, unknown>;
        if (tr.type !== "cron") {
          issues.push(`triggers[${i}].type must be "cron"`);
          continue;
        }
        if (typeof tr.cron !== "string" || tr.cron.trim() === "") {
          issues.push(`triggers[${i}].cron must be a non-empty string`);
          continue;
        }
        const entry: WorkflowTrigger = { type: "cron", cron: tr.cron };
        if (tr.enabled !== undefined) {
          if (typeof tr.enabled !== "boolean")
            issues.push(`triggers[${i}].enabled must be boolean`);
          else entry.enabled = tr.enabled;
        }
        triggers.push(entry);
      }
    }
  }
  if (issues.length > 0) throw new WorkflowParseError(issues);
  const def: WorkflowDefinition = { version: 1, id: id!, nodes, edges };
  if (Object.keys(input).length > 0) def.input = input;
  if (Object.keys(meta).length > 0) def.meta = meta;
  if (triggers.length > 0) def.triggers = triggers;
  topoSort(def); // throws GraphCycleError on cycle
  return def;
}
