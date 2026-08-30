#!/usr/bin/env bun
// agentic-workflow-dsl reference validator.
// Mirrors packages/workflow/src/parse.ts rules; run:
//   bun reference/validate.js <file.workflow.json>
// Exit 0 + "VALID <id>" when legal; exit 1 with one violation per line.
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: bun reference/validate.js <file.workflow.json>");
  process.exit(1);
}

let def;
try {
  def = JSON.parse(readFileSync(file, "utf8"));
} catch (err) {
  console.error(`$.parse ${err.message}`);
  process.exit(1);
}

const errors = [];
const NODE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const NODE_TYPES = new Set(["start", "end", "agent", "script", "human"]);
const FIELD_TYPES = new Set(["string", "textarea", "number", "enum", "date", "boolean"]);
const LOGIC_OPS = new Set([
  "var",
  "==",
  "!=",
  ">",
  ">=",
  "<",
  "<=",
  "in",
  "and",
  "or",
  "not",
  "if",
  "!!",
]);
const SCHEMA_KEYS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
]);

function checkSchema(path, schema) {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    errors.push(`${path} must be an object`);
    return;
  }
  for (const key of Object.keys(schema)) {
    if (!SCHEMA_KEYS.has(key)) errors.push(`${path}.${key} is not in the JSON Schema subset`);
  }
  if (schema.properties !== undefined) {
    for (const [k, sub] of Object.entries(schema.properties))
      checkSchema(`${path}.properties.${k}`, sub);
  }
  if (schema.items !== undefined) checkSchema(`${path}.items`, schema.items);
}

function checkWhen(path, when) {
  if (typeof when !== "object" || when === null || Array.isArray(when)) {
    errors.push(`${path} must be a JSONLogic object`);
    return;
  }
  const keys = Object.keys(when);
  if (keys.length !== 1) {
    errors.push(`${path} must have exactly one operator key`);
    return;
  }
  const op = keys[0];
  if (!LOGIC_OPS.has(op)) {
    errors.push(`${path}.${op} is not in the JSONLogic subset`);
    return;
  }
  const args = when[op];
  if (Array.isArray(args)) {
    args.forEach((a, i) => {
      if (typeof a === "object" && a !== null) checkWhen(`${path}.${op}[${i}]`, a);
    });
  } else if (typeof args === "object" && args !== null) {
    checkWhen(`${path}.${op}`, args);
  }
}

// version / id
if (def.version !== 1) errors.push("$.version must be 1");
if (typeof def.id !== "string" || def.id.trim() === "")
  errors.push("$.id must be a non-empty string");

const HINT_TYPES = new Set(["string", "number", "boolean", "artifact"]);
function checkHints(path, hints) {
  if (hints === undefined) return;
  if (!Array.isArray(hints)) {
    errors.push(`${path} must be an array of { key, type }`);
    return;
  }
  const keys = new Set();
  hints.forEach((h, i) => {
    const hp = `${path}[${i}]`;
    if (!h || typeof h !== "object") {
      errors.push(`${hp} must be an object`);
      return;
    }
    if (typeof h.key !== "string" || h.key.trim() === "")
      errors.push(`${hp}.key must be a non-empty string`);
    else if (keys.has(h.key)) errors.push(`${hp}.key "${h.key}" duplicates an earlier key`);
    else keys.add(h.key);
    if (!HINT_TYPES.has(h.type)) errors.push(`${hp}.type must be string/number/boolean/artifact`);
  });
}

// nodes
const nodes = Array.isArray(def.nodes) ? def.nodes : null;
if (!nodes || nodes.length === 0) errors.push("$.nodes must be a non-empty array");
const seen = new Set();
let starts = 0;
if (nodes) {
  nodes.forEach((n, i) => {
    const p = `$.nodes[${i}]`;
    if (typeof n !== "object" || n === null) {
      errors.push(`${p} must be an object`);
      return;
    }
    if (typeof n.id !== "string" || !NODE_ID_RE.test(n.id))
      errors.push(`${p}.id invalid (use [a-zA-Z0-9_-])`);
    else if (seen.has(n.id)) errors.push(`${p}.id duplicate "${n.id}"`);
    else seen.add(n.id);
    if (!NODE_TYPES.has(n.type)) {
      errors.push(`${p}.type unknown "${String(n.type)}"`);
      return;
    }
    if (n.type === "start") starts++;
    if (n.type === "end" && (typeof n.status !== "string" || n.status.trim() === ""))
      errors.push(`${p}.status required`);
    if (n.type === "agent") {
      const hasId = typeof n.agentId === "string" && n.agentId.trim() !== "";
      const hasInline =
        typeof n.model === "string" &&
        n.model.trim() !== "" &&
        typeof n.prompt === "string" &&
        n.prompt.trim() !== "";
      if (!hasId && !hasInline) errors.push(`${p} agent requires agentId or both model+prompt`);
    }
    if (n.type === "script" && (typeof n.code !== "string" || n.code.trim() === ""))
      errors.push(`${p}.code required`);
    checkHints(`${p}.input`, n.input);
    checkHints(`${p}.output`, n.output);
    if (n.inputSchema) checkSchema(`${p}.inputSchema`, n.inputSchema);
    if (n.outputSchema) checkSchema(`${p}.outputSchema`, n.outputSchema);
    if (n.form) {
      for (const [k, f] of Object.entries(n.form)) {
        if (!FIELD_TYPES.has(f?.type))
          errors.push(`${p}.form.${k}.type must be one of ${[...FIELD_TYPES].join("/")}`);
      }
    }
  });
  if (starts !== 1) errors.push(`expected exactly one start node, found ${starts}`);
}

// edges
const edges = Array.isArray(def.edges) ? def.edges : null;
if (!edges) errors.push("$.edges must be an array");
if (edges) {
  edges.forEach((e, i) => {
    const p = `$.edges[${i}]`;
    if (!seen.has(e.from)) errors.push(`${p}.from "${String(e.from)}" is not a node id`);
    if (!seen.has(e.to)) errors.push(`${p}.to "${String(e.to)}" is not a node id`);
    if (e.when !== undefined && e.when !== null) checkWhen(`${p}.when`, e.when);
  });
}

// workflow input hints
checkHints("$.input", def.input);

// meta
if (def.meta !== undefined) {
  if (typeof def.meta !== "object" || def.meta === null) errors.push("$.meta must be an object");
  else {
    if (def.meta.status !== undefined && !["draft", "active", "archived"].includes(def.meta.status))
      errors.push("$.meta.status must be draft|active|archived");
    if (
      def.meta.tags !== undefined &&
      !(Array.isArray(def.meta.tags) && def.meta.tags.every((t) => typeof t === "string"))
    )
      errors.push("$.meta.tags must be an array of strings");
  }
}

// acyclicity (Kahn)
if (nodes && edges) {
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  const out = new Map();
  for (const e of edges) {
    if (!seen.has(e.from) || !seen.has(e.to)) continue;
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    const list = out.get(e.from) ?? [];
    list.push(e.to);
    out.set(e.from, list);
  }
  const queue = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const order = [];
  while (queue.length > 0) {
    const id = queue.shift();
    order.push(id);
    for (const t of out.get(id) ?? []) {
      indeg.set(t, (indeg.get(t) ?? 1) - 1);
      if ((indeg.get(t) ?? 0) === 0) queue.push(t);
    }
  }
  if (order.length !== nodes.length) errors.push("cycle detected in workflow graph");
}

// triggers
if (def.triggers !== undefined) {
  if (!Array.isArray(def.triggers)) errors.push("$.triggers must be an array");
  else
    def.triggers.forEach((t, i) => {
      const p = `$.triggers[${i}]`;
      if (!t || typeof t !== "object") errors.push(`${p} must be an object`);
      else {
        if (t.type !== "cron") errors.push(`${p}.type must be "cron"`);
        if (typeof t.cron !== "string" || t.cron.trim() === "")
          errors.push(`${p}.cron must be a non-empty string`);
        if (t.enabled !== undefined && typeof t.enabled !== "boolean")
          errors.push(`${p}.enabled must be boolean`);
      }
    });
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("VALID", def.id);
