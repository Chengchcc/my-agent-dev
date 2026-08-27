# Agentic Workflow Plan 1: `@chengchenccc/workflow` 核心包

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 `packages/workflow`（`@chengchenccc/workflow`）纯逻辑核心包：DSL 类型/解析/校验、JSONLogic 子集求值、图拓扑（AND-join/隐式合并/provenance）、执行核心 `computeNext`、节点运行时契约、编辑器基础（分层布局 + graph model）。

**Architecture:** 零依赖 leaf package（仿 `packages/source-fetch`），backend/web 后续消费。纯函数无 I/O；引擎核心只算"下一步跑什么"，节点执行留给 Plan 2 的 backend shell。

**Tech Stack:** Bun 1.3, TypeScript 6 (NodeNext ESM, strict), bun:test。

Spec: `docs/superpowers/specs/2026-08-27-agentic-workflow-design.md`

---

## 文件结构

```
packages/workflow/
  package.json                 # @chengchenccc/workflow，零依赖，exports dist
  tsconfig.json                # 仿 source-fetch
  README.md
  src/
    types.ts                   # DSL 领域类型（WorkflowDefinition/WorkflowNode/EdgeDef/FormField）
    json-logic.ts              # evalJsonLogic —— JSONLogic 子集
    graph.ts                   # topoSort/routeOutgoing/mergeInputs/CompletionRecord
    engine.ts                  # computeNext —— 纯执行核心
    parse.ts                   # parseWorkflow —— 结构校验 + 归一化
    node-runtime.ts            # NodeContext/StoreApi/ScriptContext/NodeRunner 契约
    editor/
      layout.ts                # layeredLayout —— 确定性分层布局
      graph-model.ts           # toEditorGraph —— DSL → 编辑器图模型
    index.ts                   # barrel
  src/*.test.ts                # 各源文件旁测试
```

依赖方向（无环）：`types` ← `json-logic` ← `graph` ← `engine`；`parse` → `graph`；`editor/*` → `graph`/`types`。

---

### Task 0: Scaffold 包 + commitlint scope

**Files:**
- Create: `packages/workflow/package.json`
- Create: `packages/workflow/tsconfig.json`
- Create: `packages/workflow/README.md`
- Modify: `commitlint.config.mjs`

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "@chengchenccc/workflow",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "bun test"
  },
  "types": "./dist/index.d.ts",
  "files": [
    "dist"
  ]
}
```

- [ ] **Step 2: 创建 tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "types": ["bun"]
  },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 3: 创建 README.md**

```markdown
# @chengchenccc/workflow

Agentic Workflow 纯逻辑核心：DSL 类型/解析、JSONLogic 子集求值、图拓扑（AND-join/隐式合并）、执行核心、节点运行时契约、编辑器基础布局。

零依赖。backend（执行 I/O 壳）与 web（编辑器）消费本包。
```

- [ ] **Step 4: commitlint.config.mjs 增加 "workflow" scope**

在 `commitlint.config.mjs` 的 scope-enum 中，`"cron",` 后加一行：

```js
        "workflow",
```

（位置：Features 区 `"agent-run", "cron", "mcp", "settings",` 中 `"cron",` 与 `"mcp",` 之间。）

- [ ] **Step 5: 注册 workspace 并验证 scaffold**

Run: `bun install`
Expected: 无报错，bun.lock 更新。

Run: `cd packages/workflow && bun run typecheck`
Expected: PASS（空 src 也通过；若报 no inputs，先建一个空 `src/index.ts` 再跑）。

- [ ] **Step 6: Commit**

```bash
git add packages/workflow commitlint.config.mjs bun.lock
git commit -m "chore(workflow): scaffold workflow core package"
```

---

### Task 1: DSL 类型 + JSONLogic 子集求值

**Files:**
- Create: `packages/workflow/src/types.ts`
- Create: `packages/workflow/src/json-logic.test.ts`
- Create: `packages/workflow/src/json-logic.ts`

- [ ] **Step 1: 创建 types.ts**

```typescript
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
  | { [op: string]: JsonLogicRule[] | string | boolean | number | null | { default?: JsonLogicRule } };

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
    | { type: "script"; code: string; timeoutMs?: number }
    | { type: "human"; question?: string; form?: Record<string, FormField>; timeoutMs?: number }
  );

export interface EdgeDef {
  from: NodeId;
  to: NodeId;
  /** JSONLogic condition evaluated against upstream output + store. */
  when?: JsonLogicRule;
}

export interface WorkflowDefinition {
  version: 1;
  id: string;
  input?: InputHint;
  nodes: WorkflowNode[];
  edges: EdgeDef[];
}
```

- [ ] **Step 2: 写失败测试 json-logic.test.ts**

```typescript
import { describe, expect, test } from "bun:test";
import { evalJsonLogic } from "./json-logic.js";

const data = {
  store: { threshold: 3 },
  triage: { output: { severity: "high", count: 5 } },
};

describe("evalJsonLogic", () => {
  test("literals and var", () => {
    expect(evalJsonLogic(42, data)).toBe(42);
    expect(evalJsonLogic("x", data)).toBe("x");
    expect(evalJsonLogic({ var: "triage.output.severity" }, data)).toBe("high");
    expect(evalJsonLogic({ var: "triage.output.missing" }, data)).toBeNull();
    expect(evalJsonLogic({ var: ["triage.output.missing", "fallback"] }, data)).toBe("fallback");
  });

  test("comparison operators", () => {
    expect(evalJsonLogic({ "==": [{ var: "triage.output.severity" }, "high"] }, data)).toBe(true);
    expect(evalJsonLogic({ "!=": [{ var: "triage.output.severity" }, "low"] }, data)).toBe(true);
    expect(evalJsonLogic({ ">": [{ var: "triage.output.count" }, 3] }, data)).toBe(true);
    expect(evalJsonLogic({ ">=": [{ var: "store.threshold" }, 3] }, data)).toBe(true);
    expect(evalJsonLogic({ "<": [{ var: "triage.output.count" }, 1] }, data)).toBe(false);
    expect(evalJsonLogic({ "<=": [{ var: "store.threshold" }, 3] }, data)).toBe(true);
  });

  test("in operator", () => {
    expect(evalJsonLogic({ in: ["high", ["low", "high"]] }, data)).toBe(true);
    expect(evalJsonLogic({ in: ["z", "abc"] }, data)).toBe(false);
    expect(evalJsonLogic({ in: ["b", "abc"] }, data)).toBe(true);
  });

  test("logic operators", () => {
    expect(
      evalJsonLogic(
        { and: [{ "==": [{ var: "triage.output.severity" }, "high"] }, { ">": [{ var: "triage.output.count" }, 1] }] },
        data,
      ),
    ).toBe(true);
    expect(
      evalJsonLogic(
        { or: [{ "==": [{ var: "triage.output.severity" }, "low"] }, { ">": [{ var: "triage.output.count" }, 1] }] },
        data,
      ),
    ).toBe(true);
    expect(evalJsonLogic({ not: [{ "==": [{ var: "triage.output.severity" }, "low"] }] }, data)).toBe(true);
    expect(evalJsonLogic({ "!!": [{ var: "triage.output.severity" }] }, data)).toBe(true);
    expect(evalJsonLogic({ if: [{ "==": [{ var: "triage.output.severity" }, "high"] }, "a", "b"] }, data)).toBe("a");
  });

  test("plain object evaluates values", () => {
    expect(evalJsonLogic({ a: { var: "triage.output.severity" }, b: 1 }, data)).toEqual({ a: "high", b: 1 });
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd packages/workflow && bun test src/json-logic.test.ts`
Expected: FAIL — `Cannot find module './json-logic.js'`

- [ ] **Step 4: 创建 json-logic.ts**

```typescript
import type { JsonLogicRule } from "./types.js";

const OPS = new Set(["var", "==", "!=", ">", ">=", "<", "<=", "in", "and", "or", "not", "if", "!!"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (typeof v === "number" && (v === 0 || Number.isNaN(v))) return false;
  if (typeof v === "string" && v.length === 0) return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  return deepEqual(a, b) ? 0 : -1;
}

function pathGet(data: unknown, path: string): unknown {
  let cur: unknown = data;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Evaluate a JSONLogic rule against `data`.
 *  Supported subset: var, ==, !=, >, >=, <, <=, in, and, or, not, if, !!. */
export function evalJsonLogic(rule: JsonLogicRule, data: unknown): unknown {
  if (Array.isArray(rule)) return rule.map((r) => evalJsonLogic(r, data));
  if (!isObject(rule)) return rule;
  const entries = Object.entries(rule);
  if (entries.length === 1) {
    const [op, rawArgs] = entries[0]!;
    if (OPS.has(op)) {
      const args = rawArgs as JsonLogicRule[];
      switch (op) {
        case "var": {
          if (typeof rawArgs === "string") return pathGet(data, rawArgs) ?? null;
          if (Array.isArray(rawArgs)) {
            const [path, dflt] = rawArgs as unknown[];
            const v = typeof path === "string" ? pathGet(data, path) : undefined;
            return v === undefined ? (dflt === undefined ? null : evalJsonLogic(dflt as JsonLogicRule, data)) : v;
          }
          return null;
        }
        case "==":
        case "!=": {
          const eq = deepEqual(evalJsonLogic(args[0], data), evalJsonLogic(args[1], data));
          return op === "==" ? eq : !eq;
        }
        case ">":
        case ">=":
        case "<":
        case "<=": {
          const c = compare(evalJsonLogic(args[0], data), evalJsonLogic(args[1], data));
          if (op === ">") return c > 0;
          if (op === ">=") return c >= 0;
          if (op === "<") return c < 0;
          return c <= 0;
        }
        case "in": {
          const av = evalJsonLogic(args[0], data);
          const bv = evalJsonLogic(args[1], data);
          if (typeof bv === "string") return typeof av === "string" && bv.includes(av);
          if (Array.isArray(bv)) return bv.some((x) => deepEqual(x, av));
          return false;
        }
        case "and": {
          let acc: unknown = true;
          for (const r of args ?? []) {
            acc = evalJsonLogic(r, data);
            if (!truthy(acc)) return acc;
          }
          return acc;
        }
        case "or": {
          let acc: unknown = false;
          for (const r of args ?? []) {
            acc = evalJsonLogic(r, data);
            if (truthy(acc)) return acc;
          }
          return acc;
        }
        case "not": {
          return !truthy(evalJsonLogic(args[0], data));
        }
        case "!!": {
          return truthy(evalJsonLogic(args[0], data));
        }
        case "if": {
          return truthy(evalJsonLogic(args[0], data))
            ? evalJsonLogic(args[1], data)
            : evalJsonLogic(args[2], data);
        }
      }
    }
  }
  // Plain object = data — evaluate each value.
  return Object.fromEntries(entries.map(([k, v]) => [k, evalJsonLogic(v as JsonLogicRule, data)]));
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd packages/workflow && bun test src/json-logic.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/workflow/src/types.ts packages/workflow/src/json-logic.ts packages/workflow/src/json-logic.test.ts
git commit -m "feat(workflow): add dsl types and json-logic evaluator subset"
```

---

### Task 2: 图拓扑 + 路由 + 隐式合并

**Files:**
- Create: `packages/workflow/src/graph.test.ts`
- Create: `packages/workflow/src/graph.ts`

- [ ] **Step 1: 写失败测试 graph.test.ts**

```typescript
import { describe, expect, test } from "bun:test";
import { mergeInputs, routeOutgoing, topoSort } from "./graph.js";
import { parseWorkflow } from "./parse.js";

const def = parseWorkflow({
  version: 1,
  id: "wf",
  nodes: [
    { id: "start", type: "start" },
    { id: "a", type: "script", code: "export default async () => ({})" },
    { id: "b", type: "script", code: "export default async () => ({})" },
    { id: "join", type: "script", code: "export default async () => ({})" },
    { id: "done", type: "end", status: "success" },
  ],
  edges: [
    { from: "start", to: "a" },
    { from: "start", to: "b" },
    { from: "a", to: "join" },
    { from: "b", to: "join" },
    { from: "join", to: "done" },
  ],
});

describe("graph", () => {
  test("topoSort", () => {
    expect(topoSort(def)).toEqual(["start", "a", "b", "join", "done"]);
  });

  test("routeOutgoing unconditional", () => {
    expect(routeOutgoing("start", def, [{ nodeId: "start", order: 0 }], {})).toEqual(["a", "b"]);
  });

  test("routeOutgoing respects when and nextNode override", () => {
    const condDef = parseWorkflow({
      version: 1,
      id: "wf",
      nodes: [
        { id: "start", type: "start" },
        { id: "a", type: "script", code: "x" },
        { id: "b", type: "script", code: "x" },
        { id: "done", type: "end", status: "success" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "b", when: { "==": [{ var: "a.output.go" }, true] } },
        { from: "a", to: "done", when: { "!=": [{ var: "a.output.go" }, true] } },
      ],
    });
    const gone = [
      { nodeId: "start", order: 0 },
      { nodeId: "a", order: 1, output: { go: false } },
    ];
    expect(routeOutgoing("a", condDef, gone, {})).toEqual(["done"]);
    const overridden = [
      { nodeId: "start", order: 0 },
      { nodeId: "a", order: 1, output: { go: true, nextNode: "b" } },
    ];
    expect(routeOutgoing("a", condDef, overridden, {})).toEqual(["b"]);
  });

  test("mergeInputs later wins with provenance", () => {
    const result = mergeInputs(
      [
        { nodeId: "a", order: 0, output: { x: 1, y: "a" } },
        { nodeId: "b", order: 1, output: { y: "b" } },
      ],
      { z: "store" },
      { t: "trigger" },
    );
    expect(result.input).toEqual({ t: "trigger", z: "store", x: 1, y: "b" });
    expect(result.provenance).toEqual({ t: "trigger", z: "store", x: "a", y: "b" });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/workflow && bun test src/graph.test.ts`
Expected: FAIL — `Cannot find module './graph.js'`（parse.js 也尚未创建；见 Step 4 说明）。

- [ ] **Step 3: 创建 graph.ts**

```typescript
import { evalJsonLogic } from "./json-logic.js";
import type { JsonLogicRule, WorkflowDefinition } from "./types.js";

export interface CompletionRecord {
  nodeId: string;
  output?: Record<string, unknown>;
  /** Completion order index (0-based) for implicit merge. */
  order: number;
}

export class GraphCycleError extends Error {
  constructor() {
    super("cycle detected in workflow graph");
    this.name = "GraphCycleError";
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

function evalData(nodeId: string, output: Record<string, unknown> | undefined, store: Record<string, unknown>): unknown {
  return { store, [nodeId]: { output } };
}

/** Targets reachable from a completed node: truthy `when` edges (or unconditional), plus nextNode override. */
export function routeOutgoing(
  nodeId: string,
  def: WorkflowDefinition,
  completions: CompletionRecord[],
  store: Record<string, unknown>,
): string[] {
  const out = completions.find((c) => c.nodeId === nodeId)?.output;
  const override = typeof out?.nextNode === "string" ? (out.nextNode as string) : undefined;
  const edges = def.edges.filter((e) => e.from === nodeId);
  if (override !== undefined) {
    return edges.some((e) => e.to === override) ? [override] : [];
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

/** Implicit merge: trigger vars, then store, then upstream outputs in completion order (later wins). */
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
```

- [ ] **Step 4: 先搭 parse.ts 骨架让 graph 测试可跑（Task 3 再补全校验）**

创建 `packages/workflow/src/parse.ts` 骨架：

```typescript
import { topoSort } from "./graph.js";
import type { WorkflowDefinition } from "./types.js";

/** Minimal skeleton — full validation lands in Task 3. */
export function parseWorkflow(raw: unknown): WorkflowDefinition {
  return raw as WorkflowDefinition;
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd packages/workflow && bun test src/graph.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/workflow/src/graph.ts packages/workflow/src/graph.test.ts packages/workflow/src/parse.ts
git commit -m "feat(workflow): add graph topo, routing and implicit merge"
```

---

### Task 3: 执行核心 computeNext

**Files:**
- Create: `packages/workflow/src/engine.test.ts`
- Create: `packages/workflow/src/engine.ts`

- [ ] **Step 1: 写失败测试 engine.test.ts**

```typescript
import { describe, expect, test } from "bun:test";
import { computeNext } from "./engine.js";
import { parseWorkflow } from "./parse.js";

function branchDef() {
  return parseWorkflow({
    version: 1,
    id: "wf",
    nodes: [
      { id: "start", type: "start" },
      { id: "a", type: "script", code: "x", output: { severity: "string" } },
      { id: "done", type: "end", status: "success" },
      { id: "abort", type: "end", status: "failure" },
    ],
    edges: [
      { from: "start", to: "a" },
      { from: "a", to: "done", when: { "!=": [{ var: "a.output.severity" }, "critical"] } },
      { from: "a", to: "abort", when: { "==": [{ var: "a.output.severity" }, "critical"] } },
    ],
  });
}

describe("computeNext", () => {
  test("first step runs start with trigger input", () => {
    const step = computeNext(branchDef(), { completions: [], store: {}, trigger: { issueUrl: "u" } });
    if (step.kind !== "run") throw new Error("expected run");
    expect(step.ready).toHaveLength(1);
    expect(step.ready[0]!.node.id).toBe("start");
    expect(step.ready[0]!.input).toEqual({ issueUrl: "u" });
    expect(step.ready[0]!.provenance).toEqual({ issueUrl: "trigger" });
  });

  test("terminal when end ready", () => {
    const step = computeNext(branchDef(), {
      completions: [
        { nodeId: "start", order: 0, output: {} },
        { nodeId: "a", order: 1, output: { severity: "high" } },
      ],
      store: {},
      trigger: {},
    });
    expect(step).toEqual({ kind: "terminal", exit: "success" });
  });

  test("condition routes to failure exit", () => {
    const step = computeNext(branchDef(), {
      completions: [
        { nodeId: "start", order: 0, output: {} },
        { nodeId: "a", order: 1, output: { severity: "critical" } },
      ],
      store: {},
      trigger: {},
    });
    expect(step).toEqual({ kind: "terminal", exit: "failure" });
  });

  test("AND-join waits for both branches", () => {
    const def = parseWorkflow({
      version: 1,
      id: "wf",
      nodes: [
        { id: "start", type: "start" },
        { id: "a", type: "script", code: "x" },
        { id: "b", type: "script", code: "x" },
        { id: "join", type: "script", code: "x" },
        { id: "done", type: "end", status: "success" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "start", to: "b" },
        { from: "a", to: "join" },
        { from: "b", to: "join" },
        { from: "join", to: "done" },
      ],
    });
    const afterStart = computeNext(def, { completions: [{ nodeId: "start", order: 0, output: {} }], store: {}, trigger: {} });
    if (afterStart.kind !== "run") throw new Error("expected run");
    expect(afterStart.ready.map((r) => r.node.id)).toEqual(["a", "b"]);
    const afterA = computeNext(def, {
      completions: [
        { nodeId: "start", order: 0, output: {} },
        { nodeId: "a", order: 1, output: {} },
      ],
      store: {},
      trigger: {},
    });
    expect(afterA).toEqual({ kind: "idle" });
    const afterBoth = computeNext(def, {
      completions: [
        { nodeId: "start", order: 0, output: {} },
        { nodeId: "a", order: 1, output: {} },
        { nodeId: "b", order: 2, output: {} },
      ],
      store: {},
      trigger: {},
    });
    if (afterBoth.kind !== "run") throw new Error("expected run");
    expect(afterBoth.ready.map((r) => r.node.id)).toEqual(["join"]);
  });

  test("node input defaults fill missing keys only", () => {
    const def = parseWorkflow({
      version: 1,
      id: "wf",
      nodes: [
        { id: "start", type: "start" },
        { id: "a", type: "script", code: "x", input: { level: "low" } },
        { id: "done", type: "end", status: "success" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "done" },
      ],
    });
    const step = computeNext(def, {
      completions: [{ nodeId: "start", order: 0, output: { level: "high" } }],
      store: {},
      trigger: {},
    });
    if (step.kind !== "run") throw new Error("expected run");
    expect(step.ready[0]!.input).toEqual({ level: "high" });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/workflow && bun test src/engine.test.ts`
Expected: FAIL — `Cannot find module './engine.js'`

- [ ] **Step 3: 创建 engine.ts**

```typescript
import { mergeInputs, routeOutgoing, type CompletionRecord } from "./graph.js";
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

/** Pure execution core: given a definition and state, decide what runs next. */
export function computeNext(def: WorkflowDefinition, state: EngineState): EngineStep {
  const nodeOf = new Map(def.nodes.map((n) => [n.id, n]));
  const completedIds = new Set(state.completions.map((c) => c.nodeId));

  const routed = new Map<string, Set<string>>();
  for (const c of state.completions) {
    routed.set(c.nodeId, new Set(routeOutgoing(c.nodeId, def, state.completions, state.store)));
  }

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
    return { node, input: { ...(node.input ?? {}), ...input }, provenance };
  });
  return { kind: "run", ready };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/workflow && bun test src/engine.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/workflow/src/engine.ts packages/workflow/src/engine.test.ts
git commit -m "feat(workflow): add pure execution core computeNext"
```

---

### Task 4: parseWorkflow 完整校验

**Files:**
- Create: `packages/workflow/src/parse.test.ts`
- Modify: `packages/workflow/src/parse.ts`（替换骨架）

- [ ] **Step 1: 写失败测试 parse.test.ts**

```typescript
import { describe, expect, test } from "bun:test";
import { parseWorkflow, WorkflowParseError } from "./parse.js";

const base = {
  version: 1,
  id: "wf",
  nodes: [
    { id: "start", type: "start" },
    { id: "done", type: "end", status: "success" },
  ],
  edges: [{ from: "start", to: "done" }],
};

describe("parseWorkflow", () => {
  test("valid minimal", () => {
    const def = parseWorkflow(base);
    expect(def.id).toBe("wf");
    expect(def.nodes).toHaveLength(2);
  });

  test("rejects unknown node type", () => {
    expect(() => parseWorkflow({ ...base, nodes: [{ id: "x", type: "mystery" }] })).toThrow(WorkflowParseError);
  });

  test("rejects duplicate ids", () => {
    expect(() =>
      parseWorkflow({ ...base, nodes: [...base.nodes, { id: "start", type: "script", code: "x" }] }),
    ).toThrow(/duplicate node id/);
  });

  test("rejects agent without agentId or model+prompt", () => {
    expect(() => parseWorkflow({ ...base, nodes: [...base.nodes, { id: "a", type: "agent" }] })).toThrow(
      /agent requires/,
    );
  });

  test("rejects edge to unknown node", () => {
    expect(() => parseWorkflow({ ...base, edges: [{ from: "start", to: "nope" }] })).toThrow(/not a node id/);
  });

  test("rejects cycle", () => {
    expect(() =>
      parseWorkflow({
        ...base,
        edges: [
          { from: "start", to: "done" },
          { from: "done", to: "start" },
        ],
      }),
    ).toThrow(/cycle/);
  });

  test("normalizes valid agent and human", () => {
    const def = parseWorkflow({
      version: 1,
      id: "wf",
      nodes: [
        { id: "start", type: "start" },
        { id: "a", type: "agent", agentId: "ag-1" },
        { id: "h", type: "human", question: "ok?", form: { level: { type: "enum", options: ["a", "b"] } } },
        { id: "done", type: "end", status: "success" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "h" },
        { from: "h", to: "done" },
      ],
    });
    expect(def.nodes[1]).toMatchObject({ type: "agent", agentId: "ag-1" });
    expect(def.nodes[2]).toMatchObject({ type: "human", form: { level: { type: "enum", options: ["a", "b"] } } });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/workflow && bun test src/parse.test.ts`
Expected: FAIL — `WorkflowParseError` 不存在（骨架 parse.ts 无此导出）。

- [ ] **Step 3: 用完整实现替换 parse.ts**

```typescript
import { topoSort } from "./graph.js";
import type { FormField, InputHint, WorkflowDefinition, WorkflowNode } from "./types.js";

export class WorkflowParseError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(issues.join("; "));
    this.name = "WorkflowParseError";
    this.issues = issues;
  }
}

const NODE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const NODE_TYPES = new Set(["start", "end", "agent", "script", "human"]);
const FIELD_TYPES = new Set(["string", "textarea", "number", "enum", "date", "boolean"]);

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
  if (typeof raw.type !== "string" || !FIELD_TYPES.has(raw.type)) {
    issues.push(`form.${name}.type must be one of ${[...FIELD_TYPES].join("/")}`);
    return undefined;
  }
  const field: FormField = { type: raw.type as FormField["type"] };
  if (typeof raw.label === "string") field.label = raw.label;
  if (typeof raw.required === "boolean") field.required = raw.required;
  if (Array.isArray(raw.options) && raw.options.every((o) => typeof o === "string")) field.options = raw.options;
  return field;
}

function parseNode(raw: unknown, issues: string[]): WorkflowNode | undefined {
  if (!isRecord(raw)) {
    issues.push("node must be an object");
    return undefined;
  }
  const id = nonEmptyString(raw.id, "node.id", issues);
  if (id && !NODE_ID_RE.test(id)) issues.push(`node.id "${id}" contains invalid characters (use [a-zA-Z0-9_-])`);
  if (typeof raw.type !== "string" || !NODE_TYPES.has(raw.type)) {
    issues.push(`node "${id ?? "?"}" has unknown type ${String(raw.type)}`);
    return undefined;
  }
  const node: Record<string, unknown> = { id, type: raw.type };
  if (isRecord(raw.input)) node.input = raw.input;
  if (isRecord(raw.output)) node.output = raw.output;
  if (typeof raw.retry === "number" && Number.isInteger(raw.retry) && raw.retry >= 0) node.retry = raw.retry;
  switch (raw.type) {
    case "end": {
      const status = nonEmptyString(raw.status, `node "${id}" status`, issues);
      if (status) node.status = status;
      break;
    }
    case "agent": {
      const agentId = typeof raw.agentId === "string" && raw.agentId.trim() !== "" ? raw.agentId : undefined;
      const model = typeof raw.model === "string" && raw.model.trim() !== "" ? raw.model : undefined;
      const prompt = typeof raw.prompt === "string" && raw.prompt.trim() !== "" ? raw.prompt : undefined;
      if (!agentId && !(model && prompt)) issues.push(`node "${id}" agent requires agentId or both model+prompt`);
      if (agentId) node.agentId = agentId;
      if (model) node.model = model;
      if (prompt) node.prompt = prompt;
      if (typeof raw.repo === "string" && raw.repo.trim() !== "") node.repo = raw.repo;
      break;
    }
    case "script": {
      const code = nonEmptyString(raw.code, `node "${id}" code`, issues);
      if (code) node.code = code;
      if (typeof raw.timeoutMs === "number" && raw.timeoutMs > 0) node.timeoutMs = raw.timeoutMs;
      break;
    }
    case "human": {
      if (typeof raw.question === "string" && raw.question.trim() !== "") node.question = raw.question;
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
      if (from && to) edges.push({ from, to, when: e.when });
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
        if (v !== "string" && v !== "number" && v !== "boolean") issues.push(`input.${k} must be string/number/boolean hint`);
        else input[k] = v;
      }
    }
  }
  if (issues.length > 0) throw new WorkflowParseError(issues);
  const def: WorkflowDefinition = { version: 1, id: id!, nodes, edges };
  if (Object.keys(input).length > 0) def.input = input;
  topoSort(def); // throws GraphCycleError on cycle
  return def;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/workflow && bun test src/parse.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/workflow/src/parse.ts packages/workflow/src/parse.test.ts
git commit -m "feat(workflow): add full workflow dsl validation"
```

---

### Task 5: 节点运行时契约

**Files:**
- Create: `packages/workflow/src/node-runtime.ts`

- [ ] **Step 1: 创建 node-runtime.ts（纯类型，无测试）**

```typescript
import type { WorkflowNode } from "./types.js";

/** Per-node-instance context. */
export interface NodeContext {
  executionId: string;
  nodeId: string;
  workflowId: string;
  repo?: string;
}

/** Execution-scoped store API injected into script nodes. */
export interface StoreApi {
  get(key: string): unknown;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Capabilities injected into a script node's default export. */
export interface ScriptContext {
  input: Record<string, unknown>;
  store: StoreApi;
  context: NodeContext;
  log(event: string, data?: Record<string, unknown>): void;
}

/** Result of running a node. */
export interface NodeRunResult {
  output?: Record<string, unknown>;
}

/** Contract implemented by the backend I/O shell (Plan 2). */
export interface NodeRunner {
  run(
    node: WorkflowNode,
    deps: { input: Record<string, unknown>; store: StoreApi; context: NodeContext },
  ): Promise<NodeRunResult>;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/workflow/src/node-runtime.ts
git commit -m "feat(workflow): add node runtime contracts"
```

---

### Task 6: 编辑器基础（分层布局 + graph model）

**Files:**
- Create: `packages/workflow/src/editor/layout.ts`
- Create: `packages/workflow/src/editor/layout.test.ts`
- Create: `packages/workflow/src/editor/graph-model.ts`
- Create: `packages/workflow/src/editor/graph-model.test.ts`

- [ ] **Step 1: 创建 layout.ts**

```typescript
import { topoSort } from "../graph.js";
import type { WorkflowDefinition } from "../types.js";

export interface PositionedNode {
  id: string;
  x: number;
  y: number;
  layer: number;
}

const LAYER_GAP_X = 260;
const NODE_GAP_Y = 120;

/** Deterministic layered layout: longest-path layer + per-layer stacking. */
export function layeredLayout(def: WorkflowDefinition): PositionedNode[] {
  const order = topoSort(def);
  const layer = new Map<string, number>();
  for (const id of order) layer.set(id, 0);
  for (const id of order) {
    const cur = layer.get(id) ?? 0;
    for (const e of def.edges) {
      if (e.from === id) layer.set(e.to, Math.max(layer.get(e.to) ?? 0, cur + 1));
    }
  }
  const indexInLayer = new Map<string, number>();
  const counts = new Map<number, number>();
  for (const id of order) {
    const l = layer.get(id) ?? 0;
    const idx = counts.get(l) ?? 0;
    indexInLayer.set(id, idx);
    counts.set(l, idx + 1);
  }
  return order.map((id) => ({
    id,
    layer: layer.get(id) ?? 0,
    x: (layer.get(id) ?? 0) * LAYER_GAP_X,
    y: (indexInLayer.get(id) ?? 0) * NODE_GAP_Y,
  }));
}
```

- [ ] **Step 2: 创建 layout.test.ts**

```typescript
import { describe, expect, test } from "bun:test";
import { layeredLayout } from "./layout.js";
import { parseWorkflow } from "../parse.js";

describe("layeredLayout", () => {
  test("layers and positions", () => {
    const def = parseWorkflow({
      version: 1,
      id: "wf",
      nodes: [
        { id: "start", type: "start" },
        { id: "a", type: "script", code: "x" },
        { id: "b", type: "script", code: "x" },
        { id: "join", type: "script", code: "x" },
        { id: "done", type: "end", status: "success" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "start", to: "b" },
        { from: "a", to: "join" },
        { from: "b", to: "join" },
        { from: "join", to: "done" },
      ],
    });
    const byId = new Map(layeredLayout(def).map((p) => [p.id, p]));
    expect(byId.get("start")!.layer).toBe(0);
    expect(byId.get("a")!.layer).toBe(1);
    expect(byId.get("b")!.layer).toBe(1);
    expect(byId.get("join")!.layer).toBe(2);
    expect(byId.get("done")!.layer).toBe(3);
    expect(byId.get("b")!.y).toBeGreaterThan(byId.get("a")!.y);
    expect(byId.get("done")!.x).toBeGreaterThan(byId.get("join")!.x);
  });
});
```

- [ ] **Step 3: 创建 graph-model.ts**

```typescript
import { layeredLayout, type PositionedNode } from "./layout.js";
import type { WorkflowDefinition, WorkflowNode } from "../types.js";

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
```

- [ ] **Step 4: 创建 graph-model.test.ts**

```typescript
import { describe, expect, test } from "bun:test";
import { toEditorGraph } from "./graph-model.js";
import { parseWorkflow } from "../parse.js";

describe("toEditorGraph", () => {
  test("maps nodes and edges", () => {
    const def = parseWorkflow({
      version: 1,
      id: "wf",
      nodes: [
        { id: "start", type: "start" },
        { id: "a", type: "agent", agentId: "ag-1" },
        { id: "done", type: "end", status: "success" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "done", when: { "==": [{ var: "a.output.ok" }, true] } },
      ],
    });
    const g = toEditorGraph(def);
    expect(g.nodes).toHaveLength(3);
    expect(g.nodes.find((n) => n.id === "a")!.label).toBe("Agent: ag-1");
    expect(g.edges).toHaveLength(2);
    expect(g.edges[1]!.label).toBe(JSON.stringify({ "==": [{ var: "a.output.ok" }, true] }));
  });
});
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd packages/workflow && bun test src/editor`
Expected: PASS, 2 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/workflow/src/editor
git commit -m "feat(workflow): add editor layered layout and graph model"
```

---

### Task 7: barrel 导出 + 全绿收口

**Files:**
- Create: `packages/workflow/src/index.ts`

- [ ] **Step 1: 创建 index.ts**

```typescript
export * from "./types.js";
export * from "./json-logic.js";
export * from "./graph.js";
export * from "./engine.js";
export * from "./parse.js";
export * from "./node-runtime.js";
export * from "./editor/layout.js";
export * from "./editor/graph-model.js";
```

- [ ] **Step 2: 全量验证**

Run: `cd packages/workflow && bun test`
Expected: 全部测试 PASS（json-logic 5 + graph 4 + engine 5 + parse 7 + editor 2 = 23）。

Run: `cd packages/workflow && bun run typecheck`
Expected: PASS。

Run: `cd packages/workflow && bun run build`
Expected: PASS，生成 `dist/`。

Run: `cd /root/my-agent-team && bun run typecheck`
Expected: PASS（root 全仓 typecheck 不受影响）。

- [ ] **Step 3: Commit**

```bash
git add packages/workflow/src/index.ts packages/workflow/dist
git commit -m "feat(workflow): export workflow core package barrel"
```

（若 dist 在 .gitignore 中，只 add `src/index.ts`；commit 后确认 `git status` 干净。）
