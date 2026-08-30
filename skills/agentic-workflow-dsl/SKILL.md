---
name: agentic-workflow-dsl
description: >
  Generate or validate an Agentic Workflow DSL (*.workflow.json): the node graph
  (start/end/agent/script/human), JSONLogic edge conditions, meta, and
  input/output schemas. Not for oma subagent fan-out orchestration (see
  workflow-authoring).
user_invocable: true
---

# Agentic Workflow DSL

## Purpose

Two jobs: **generate** a legal DSL, and **validate** a DSL's legality. A legal
DSL is one that passes `parseWorkflow` (packages/workflow) — and the
`reference/validate.js` script in this skill implements the same rules
standalone; run it to check any file:

```bash
bun <skill-dir>/reference/validate.js path/to/x.workflow.json
```

Exit 0 + `VALID <id>` = legal; exit 1 = one violation per line.

## Shape

```jsonc
{
  "version": 1,
  "id": "oncall-triage",
  "meta": { "name": "…", "description": "…", "tags": ["…"], "status": "draft|active|archived", "owner": "…", "updatedBy": "…" },
  "input": [
    { "key": "issueUrl", "type": "string" },
    { "key": "report", "type": "artifact" }
  ],
  "triggers": [ { "type": "cron", "cron": "0 2 * * *", "enabled": true } ],
  "nodes": [ /* see Node types */ ],
  "edges": [ { "from": "a", "to": "b", "when": { "==": [ { "var": "a.output.x" }, "high" ] } } ]
}
```

**Triggers** (optional): `triggers` is an array. Each item is
`{ "type": "cron", "cron": "<5-field expr UTC>", "enabled": true }`. API trigger
is implicit — any workflow can be invoked via `POST /api/workflow-executions`;
cron triggers only add scheduling. `"enabled": false` keeps a trigger
registered but paused.

## Node types

| type | required | notes |
|---|---|---|
| start | — | entry; output = trigger vars; exactly one |
| end | `status` | success/failure/custom; multi-exit allowed |
| agent | `agentId` OR (`model`+`prompt`) | may return `nextNode` to override edges |
| script | `code` | Bun TS default export; optional `timeoutMs` |
| human | optional `question`/`form` | ask-user; answers = output |

Optional per-node `inputSchema`/`outputSchema` (JSON Schema subset), `retry`,
and `input`/`output` hints — both are arrays of `{ "key": …, "type": … }` with
type one of `string | number | boolean | artifact` (same shape as the
workflow-level `input`).

**artifact type**: a field whose value is an `artifacts://<folder>/<file>`
URL. Input artifact fields are checked to exist before the node runs; output
artifact fields must exist after it runs (the node must upload them via the
`artifact_upload` MCP tool). Use them to hand files between agents.

## Edges

- `{ from, to, when? }`; `when` is JSONLogic **subset**: `var`/`==`/`!=`/`>`/
  `>=`/`<`/`<=`/`in`/`and`/`or`/`not`/`if`/`!!`; paths are `nodeId.output.field`.
- Multi-true edges = parallel fan-out — keep branch conditions mutually
  exclusive unless parallel is intended.
- `nextNode` override must target a node an existing edge already reaches.

## Validate — legality checklist (mirror parseWorkflow)

1. `version` must be `1`; `id` non-empty.
2. Exactly one `start`; node ids `/^[a-zA-Z0-9_-]+$/`, unique, non-empty.
3. `nodes` non-empty; each `type` in start|end|agent|script|human.
4. Per-type required: end `status`; agent `agentId` OR (`model` AND `prompt`); script `code`.
5. `edges` reference existing node ids (both ends).
6. Graph acyclic (Kahn must cover all nodes).
7. `when` uses only the JSONLogic subset above.
8. `input`/`output` (workflow and per-node) are arrays of
   `{ "key": non-empty string, "type": "string"|"number"|"boolean"|"artifact" }`;
   keys unique within each array. Object maps are NOT accepted.
9. `inputSchema`/`outputSchema` use only: `type/properties/required/
   additionalProperties/items/enum/minimum/maximum/minLength/maxLength/
   minItems/maxItems`.
10. `meta.status` in draft|active|archived; `meta.tags` array of strings.

Report violations as `$.nodes[2].status missing` style paths; when asked to
fix, return the corrected full DSL.

## Output contract

When asked to author/edit, respond with **the entire updated DSL as a single
JSON object** (no markdown fence, no prose). The caller parses it, runs the
validator, and applies it as a patch.
