# Agentic Workflow Plan 2: backend 执行壳

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `apps/backend/src/features/workflow/` 实现 agentic workflow 执行壳：持久化 execution + node-run、三节点 runner（script/agent/human）、纯引擎驱动循环、HTTP API（POST + SSE + human-task resolve）、bootstrapping 接线。

**Architecture:** 新增六边形 feature（domain/ports/adapter-sqlite/service/http）。消费已落地的 `@chengchenccc/workflow`（computeNext/routeOutgoing/mergeInputs/CompletionRecord）。节点执行走现有 infra：agent → `agentRunService.enqueueAndAcquire` + `agentRunExecution.dispatch/subscribe`；human → `pendingAction` 挂起/恢复；script → Bun 临时文件 import。

**Tech Stack:** Bun 1.3, Elysia, Drizzle ORM + SQLite, `@chengchenccc/workflow`, bun:test。

Spec: `docs/superpowers/specs/2026-08-27-agentic-workflow-design.md`

**范围外（后续 plan）：** CronJob workflow target、loop 删除、编辑器 web。

---

## 文件结构

```
apps/backend/src/features/workflow/
  domain.ts                # WorkflowExecutionRow / WorkflowNodeRunRow / 状态
  ports.ts                 # WorkflowExecutionPort
  adapter-sqlite.ts        # sqliteWorkflowExecutionAdapter(db)
  node-runners.ts          # createNodeRunners({...}) → {agent, script, human}
  service.ts               # createWorkflowExecutionService + 纯引擎循环
  http.ts                  # workflowRoutes
  index.ts                 # barrel
  *.test.ts

apps/backend/src/infra/db/schema.ts        # + workflowExecution/workflowNodeRun 两表
apps/backend/drizzle/backend/0040_workflow_execution.sql
apps/backend/drizzle/backend/meta/_journal.json   # + idx 40
apps/backend/src/bootstrap/features.ts     # 接线 workflow feature
apps/backend/src/bootstrap/services.ts     # 无需改（db 已存在）
apps/backend/src/app.ts                    # FeatureSet + .use(workflowExecutions)
```

---

### Task 1: schema + migration

**Files:**
- Modify: `apps/backend/src/infra/db/schema.ts`
- Create: `apps/backend/drizzle/backend/0040_workflow_execution.sql`
- Modify: `apps/backend/drizzle/backend/meta/_journal.json`

- [ ] **Step 1: schema.ts 增加两表**（追加到 `cronJob` 表定义之后）

```typescript
// Workflow execution: one run of a WorkflowDefinition DSL.
export const workflowExecution = sqliteTable(
  "workflow_execution",
  {
    executionId: text("execution_id").notNull().primaryKey(),
    workflowId: text("workflow_id").notNull(),
    /** JSON snapshot of the WorkflowDefinition that started this execution. */
    definition: text("definition").notNull(),
    /** JSON trigger input vars (start node input). */
    input: text("input").notNull(),
    /** Execution-scoped store (JSON KV). */
    store: text("store").notNull().default("{}"),
    status: text().notNull().default("running"), // running | waiting_human | success | failure | custom
    /** exit status label (end node status). */
    exit: text(),
    error: text(),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    terminalAt: integer("terminal_at", { mode: "number" }),
  },
);

// Per-node run record (one row per node execution/attempt).
export const workflowNodeRun = sqliteTable(
  "workflow_node_run",
  {
    seq: integer().primaryKey({ autoIncrement: true }),
    executionId: text("execution_id")
      .notNull()
      .references(() => workflowExecution.executionId, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    /** runtime status: running | completed | failed | waiting_human */
    status: text().notNull().default("running"),
    order: integer().notNull(),
    /** JSON node output. */
    output: text(),
    /** JSON routed targets (frozen at completion). */
    routedTo: text(),
    error: text(),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    terminalAt: integer("terminal_at", { mode: "number" }),
  },
  (table) => [index("idx_workflow_node_run_exec").on(table.executionId, table.seq)],
);
```

- [ ] **Step 2: 创建 migration SQL**（两条语句必须带 `--> statement-breakpoint`）

```sql
CREATE TABLE IF NOT EXISTS workflow_execution (
  execution_id text PRIMARY KEY NOT NULL,
  workflow_id text NOT NULL,
  definition text NOT NULL,
  input text NOT NULL,
  store text NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'running',
  exit text,
  error text,
  created_at integer NOT NULL,
  terminal_at integer
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS workflow_node_run (
  seq integer PRIMARY KEY AUTOINCREMENT,
  execution_id text NOT NULL REFERENCES workflow_execution(execution_id) ON DELETE CASCADE,
  node_id text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  order integer NOT NULL,
  output text,
  routed_to text,
  error text,
  created_at integer NOT NULL,
  terminal_at integer
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_workflow_node_run_exec ON workflow_node_run(execution_id, seq);
```

- [ ] **Step 3: journal 追加 idx 40**

在 `meta/_journal.json` 的 `entries` 数组末尾追加：

```json
{
  "idx": 40,
  "version": "7",
  "when": 1788200000000,
  "tag": "0040_workflow_execution",
  "breakpoints": true
}
```

- [ ] **Step 4: 验证迁移**

Run: `cd apps/backend && bun test`（现有 schema/migrate 测试确保新表能被迁移器读取；若有 `migrate.test.ts` / schema.test.ts 确认 PRAGMA table_info 含 workflow_execution/workflow_node_run）。

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/infra/db/schema.ts apps/backend/drizzle/backend/0040_workflow_execution.sql apps/backend/drizzle/backend/meta/_journal.json
git commit -m "feat(workflow): add workflow execution and node run schema"
```

---

### Task 2: domain + ports

**Files:**
- Create: `apps/backend/src/features/workflow/domain.ts`
- Create: `apps/backend/src/features/workflow/ports.ts`

- [ ] **Step 1: 创建 domain.ts**

```typescript
import type { WorkflowDefinition } from "@chengchenccc/workflow";

export type WorkflowExecutionStatus =
  | "running"
  | "waiting_human"
  | "success"
  | "failure"
  | "custom";

export type WorkflowNodeRunStatus = "running" | "waiting_human" | "completed" | "failed";

export interface WorkflowExecutionRow {
  executionId: string;
  workflowId: string;
  /** JSON-serialized WorkflowDefinition snapshot. */
  definition: WorkflowDefinition;
  /** Trigger input vars. */
  input: Record<string, unknown>;
  /** Execution-scoped KV store. */
  store: Record<string, unknown>;
  status: WorkflowExecutionStatus;
  exit?: string;
  error?: string;
  createdAt: number;
  terminalAt?: number;
}

export interface WorkflowNodeRunRow {
  seq: number;
  executionId: string;
  nodeId: string;
  status: WorkflowNodeRunStatus;
  order: number;
  output?: Record<string, unknown>;
  routedTo?: string[];
  error?: string;
  createdAt: number;
  terminalAt?: number;
}

export interface CreateWorkflowExecutionInput {
  executionId: string;
  workflowId: string;
  definition: WorkflowDefinition;
  input: Record<string, unknown>;
  store: Record<string, unknown>;
  status?: WorkflowExecutionStatus;
  createdAt?: number;
}

export interface AppendNodeRunInput {
  executionId: string;
  nodeId: string;
  status: WorkflowNodeRunStatus;
  order: number;
  output?: Record<string, unknown>;
  routedTo?: string[];
  error?: string;
  createdAt?: number;
}
```

- [ ] **Step 2: 创建 ports.ts**

```typescript
import type {
  AppendNodeRunInput,
  CreateWorkflowExecutionInput,
  WorkflowExecutionRow,
  WorkflowNodeRunRow,
} from "./domain.js";

export interface WorkflowExecutionPort {
  createExecution(input: CreateWorkflowExecutionInput): Promise<WorkflowExecutionRow>;
  getExecution(executionId: string): Promise<WorkflowExecutionRow | null>;
  updateExecution(
    executionId: string,
    patch: Partial<Pick<WorkflowExecutionRow, "status" | "exit" | "error" | "store" | "terminalAt">>,
  ): Promise<WorkflowExecutionRow | null>;
  appendNodeRun(input: AppendNodeRunInput): Promise<WorkflowNodeRunRow>;
  updateNodeRun(
    executionId: string,
    nodeId: string,
    patch: Partial<Pick<WorkflowNodeRunRow, "status" | "output" | "routedTo" | "error" | "terminalAt">>,
  ): Promise<WorkflowNodeRunRow | null>;
  listNodeRuns(executionId: string): Promise<WorkflowNodeRunRow[]>;
  listRunningExecutions(): Promise<WorkflowExecutionRow[]>;
  listWaitingHumanExecutions(): Promise<WorkflowExecutionRow[]>;
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/features/workflow/domain.ts apps/backend/src/features/workflow/ports.ts
git commit -m "feat(workflow): add workflow domain and port contracts"
```

---

### Task 3: adapter-sqlite

**Files:**
- Create: `apps/backend/src/features/workflow/adapter-sqlite.test.ts`
- Create: `apps/backend/src/features/workflow/adapter-sqlite.ts`

- [ ] **Step 1: 写失败测试 adapter-sqlite.test.ts**

```typescript
import { describe, expect, test } from "bun:test";
import { createWorkflowExecutionAdapter } from "./adapter-sqlite.js";
import type { WorkflowDefinition } from "@chengchenccc/workflow";

const def: WorkflowDefinition = {
  version: 1,
  id: "wf",
  nodes: [
    { id: "start", type: "start" },
    { id: "done", type: "end", status: "success" },
  ],
  edges: [{ from: "start", to: "done" }],
};

describe("sqliteWorkflowExecutionAdapter", () => {
  test("create/get execution and append/update node runs", async (t) => {
    const db = await import("@my-agent-team/backend").then((m) => m.createTestDb()); // or in-memory
    const port = createWorkflowExecutionAdapter(db);
    await port.createExecution({ executionId: "e1", workflowId: "wf", definition: def, input: {}, store: {} });
    const row = await port.getExecution("e1");
    expect(row?.workflowId).toBe("wf");

    const nodeRun = await port.appendNodeRun({ executionId: "e1", nodeId: "start", status: "completed", order: 0 });
    expect(nodeRun.nodeId).toBe("start");
    await port.updateNodeRun("e1", "start", { output: { ok: true }, routedTo: ["done"] });
    const runs = await port.listNodeRuns("e1");
    expect(runs[0]!.output).toEqual({ ok: true });
    expect(runs[0]!.routedTo).toEqual(["done"]);
  });
});
```

（若 `createTestDb` 不存在，用 `openDb(":memory:")` 代替；需查 backend 测试 DB 注入方式。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/backend && bun test features/workflow/adapter-sqlite.test.ts`
Expected: FAIL — `Cannot find module './adapter-sqlite.js'`

- [ ] **Step 3: 创建 adapter-sqlite.ts**

```typescript
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { workflowExecution, workflowNodeRun } from "../../infra/db/schema.js";
import type {
  AppendNodeRunInput,
  CreateWorkflowExecutionInput,
  WorkflowExecutionRow,
  WorkflowNodeRunRow,
} from "./domain.js";
import type { WorkflowExecutionPort } from "./ports.js";

function toExecutionRow(r: typeof workflowExecution.$inferSelect): WorkflowExecutionRow {
  return {
    executionId: r.executionId,
    workflowId: r.workflowId,
    definition: JSON.parse(r.definition),
    input: JSON.parse(r.input),
    store: JSON.parse(r.store),
    status: r.status as WorkflowExecutionRow["status"],
    exit: r.exit ?? undefined,
    error: r.error ?? undefined,
    createdAt: r.createdAt,
    terminalAt: r.terminalAt ?? undefined,
  };
}

function toNodeRunRow(r: typeof workflowNodeRun.$inferSelect): WorkflowNodeRunRow {
  return {
    seq: r.seq,
    executionId: r.executionId,
    nodeId: r.nodeId,
    status: r.status as WorkflowNodeRunRow["status"],
    order: r.order,
    output: r.output ? JSON.parse(r.output) : undefined,
    routedTo: r.routedTo ? JSON.parse(r.routedTo) : undefined,
    error: r.error ?? undefined,
    createdAt: r.createdAt,
    terminalAt: r.terminalAt ?? undefined,
  };
}

export function createWorkflowExecutionAdapter(db: Database): WorkflowExecutionPort {
  const d = drizzle(db, { schema: { workflowExecution, workflowNodeRun } });
  return {
    async createExecution(input: CreateWorkflowExecutionInput) {
      const [row] = await d.insert(workflowExecution).values({
        executionId: input.executionId,
        workflowId: input.workflowId,
        definition: JSON.stringify(input.definition),
        input: JSON.stringify(input.input),
        store: JSON.stringify(input.store),
        status: input.status ?? "running",
        createdAt: input.createdAt ?? Date.now(),
      }).returning();
      return toExecutionRow(row!);
    },
    async getExecution(executionId) {
      const rows = await d.select().from(workflowExecution).where(eq(workflowExecution.executionId, executionId));
      const r = rows[0];
      return r ? toExecutionRow(r) : null;
    },
    async updateExecution(executionId, patch) {
      const values: Record<string, unknown> = {};
      if (patch.status !== undefined) values.status = patch.status;
      if (patch.exit !== undefined) values.exit = patch.exit;
      if (patch.error !== undefined) values.error = patch.error;
      if (patch.store !== undefined) values.store = JSON.stringify(patch.store);
      if (patch.terminalAt !== undefined) values.terminalAt = patch.terminalAt;
      if (Object.keys(values).length === 0) return this.getExecution(executionId);
      await d.update(workflowExecution).set(values).where(eq(workflowExecution.executionId, executionId));
      return this.getExecution(executionId);
    },
    async appendNodeRun(input: AppendNodeRunInput) {
      const [row] = await d.insert(workflowNodeRun).values({
        executionId: input.executionId,
        nodeId: input.nodeId,
        status: input.status,
        order: input.order,
        output: input.output ? JSON.stringify(input.output) : null,
        routedTo: input.routedTo ? JSON.stringify(input.routedTo) : null,
        error: input.error ?? null,
        createdAt: input.createdAt ?? Date.now(),
      }).returning();
      return toNodeRunRow(row!);
    },
    async updateNodeRun(executionId, nodeId, patch) {
      const values: Record<string, unknown> = {};
      if (patch.status !== undefined) values.status = patch.status;
      if (patch.output !== undefined) values.output = patch.output ? JSON.stringify(patch.output) : null;
      if (patch.routedTo !== undefined) values.routedTo = patch.routedTo ? JSON.stringify(patch.routedTo) : null;
      if (patch.error !== undefined) values.error = patch.error;
      if (patch.terminalAt !== undefined) values.terminalAt = patch.terminalAt;
      if (Object.keys(values).length === 0) return null;
      await d.update(workflowNodeRun).set(values).where(
        (w: typeof workflowNodeRun) => eq(w.executionId, executionId) && eq(w.nodeId, nodeId),
      );
      const rows = await d.select().from(workflowNodeRun).where(
        (w: typeof workflowNodeRun) => eq(w.executionId, executionId) && eq(w.nodeId, nodeId),
      );
      const r = rows[0];
      return r ? toNodeRunRow(r) : null;
    },
    async listNodeRuns(executionId) {
      const rows = await d.select().from(workflowNodeRun).where(eq(workflowNodeRun.executionId, executionId)).orderBy(workflowNodeRun.seq);
      return rows.map(toNodeRunRow);
    },
    async listRunningExecutions() {
      const rows = await d.select().from(workflowExecution).where(eq(workflowExecution.status, "running"));
      return rows.map(toExecutionRow);
    },
    async listWaitingHumanExecutions() {
      const rows = await d.select().from(workflowExecution).where(eq(workflowExecution.status, "waiting_human"));
      return rows.map(toExecutionRow);
    },
  };
}

export type WorkflowExecutionAdapter = ReturnType<typeof createWorkflowExecutionAdapter>;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/backend && bun test features/workflow/adapter-sqlite.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/features/workflow/adapter-sqlite.ts apps/backend/src/features/workflow/adapter-sqlite.test.ts
git commit -m "feat(workflow): add workflow execution sqlite adapter"
```

---

### Task 4: node runners

**Files:**
- Create: `apps/backend/src/features/workflow/node-runners.test.ts`
- Create: `apps/backend/src/features/workflow/node-runners.ts`

- [ ] **Step 1: 写失败测试 node-runners.test.ts**

```typescript
import { describe, expect, test } from "bun:test";
import { createNodeRunners } from "./node-runners.js";

describe("createNodeRunners", () => {
  test("script node executes TS default export", async () => {
    const runners = createNodeRunners({ dataDir: ".backend-data/workflow-scripts" });
    const out = await runners.script.run(
      { id: "s", type: "script", code: "export default async (ctx) => ({ sent: ctx.input.x })" },
      { input: { x: 1 }, store: {}, context: { executionId: "e", nodeId: "s", workflowId: "wf" } },
    );
    expect(out.output).toEqual({ sent: 1 });
  });

  test("human node creates pendingAction", async () => {
    const created: Array<{ action: { kind: string; payload: Record<string, unknown> } }> = [];
    const runners = createNodeRunners({
      dataDir: ".data",
      agentRunService: { createPendingAction: async (runId, action) => { created.push(action); return { actionId: "a", runId, kind: action.kind, payload: action.payload, status: "pending" }; } } as any,
    });
    const out = await runners.human.run(
      { id: "h", type: "human", question: "ok?", form: { level: { type: "enum", options: ["a", "b"] } } },
      { input: {}, store: {}, context: { executionId: "e", nodeId: "h", workflowId: "wf" } },
    );
    expect(created[0]!.action.kind).toContain("human_task");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/backend && bun test features/workflow/node-runners.test.ts`
Expected: FAIL — `Cannot find module './node-runners.js'`

- [ ] **Step 3: 创建 node-runners.ts**

```typescript
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { NodeRunResult, NodeContext, StoreApi, WorkflowNode } from "@chengchenccc/workflow";

export interface NodeRunnerDeps {
  dataDir: string;
  agentRunService?: {
    createPendingAction(runId: string, action: { kind: string; payload: Readonly<Record<string, unknown>> }): Promise<{ actionId: string; runId: string; kind: string; payload: Record<string, unknown>; status: string }>;
  };
}

function resolved<T>(value: T): Promise<NodeRunResult> {
  return Promise.resolve({ output: value as Record<string, unknown> });
}

export function createNodeRunners(deps: NodeRunnerDeps) {
  return {
    script: {
      async run(node: WorkflowNode, ctx: { input: Record<string, unknown>; store: StoreApi; context: NodeContext }): Promise<NodeRunResult> {
        if (node.type !== "script") throw new Error(`not a script node: ${node.type}`);
        mkdirSync(deps.dataDir, { recursive: true });
        const file = join(deps.dataDir, `${ctx.context.executionId}-${node.id}.ts`);
        writeFileSync(file, node.code);
        try {
          const mod = await import(`${file}?t=${Date.now()}${Math.random()}`);
          const fn = mod.default;
          const out = await fn(ctx);
          return { output: out ?? {} };
        } finally {
          rmSync(file, { force: true });
        }
      },
    },
    human: {
      async run(node: WorkflowNode, ctx: { input: Record<string, unknown>; store: StoreApi; context: NodeContext }): Promise<NodeRunResult> {
        if (node.type !== "human") throw new Error(`not a human node: ${node.type}`);
        if (!deps.agentRunService) throw new Error("human runner requires agentRunService");
        const form = node.form ?? {};
        const created = await deps.agentRunService.createPendingAction(ctx.context.executionId, {
          kind: "human_task_requested",
          payload: { executionId: ctx.context.executionId, nodeId: node.id, question: node.question, form },
        });
        // The service pauses; completion of the human node is delivered via
        // resolveHumanTask (service.ts), which calls `human.complete(...)`.
        return { output: { pendingActionId: created.actionId } };
      },
    },
    // agent runner is implemented in service.ts as it needs the full
    // agent-run lifecycle (enqueue+dispatch+subscribe); declared here for symmetry.
    agent: {
      async run(): Promise<NodeRunResult> {
        throw new Error("agent runner implemented in service.ts");
      },
    },
  };
}

export type NodeRunners = ReturnType<typeof createNodeRunners>;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/backend && bun test features/workflow/node-runners.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/features/workflow/node-runners.ts apps/backend/src/features/workflow/node-runners.test.ts
git commit -m "feat(workflow): add script and human node runners"
```

---

### Task 5: 执行 service（纯引擎循环）

**Files:**
- Create: `apps/backend/src/features/workflow/service.test.ts`
- Create: `apps/backend/src/features/workflow/service.ts`

- [ ] **Step 1: 写失败测试 service.test.ts**

```typescript
import { describe, expect, test } from "bun:test";
import { createWorkflowExecutionService } from "./service.js";
import type { WorkflowDefinition } from "@chengchenccc/workflow";

function makeDef(): WorkflowDefinition {
  return {
    version: 1,
    id: "wf",
    nodes: [
      { id: "start", type: "start" },
      { id: "s", type: "script", code: "export default async (ctx) => ({ val: ctx.input.num })", output: { val: "number" } },
      { id: "done", type: "end", status: "success" },
    ],
    edges: [
      { from: "start", to: "s" },
      { from: "s", to: "done" },
    ],
  };
}

describe("createWorkflowExecutionService", () => {
  test("runs a linear workflow to terminal success", async () => {
    const store: Map<string, unknown> = new Map();
    const executions: Array<Record<string, unknown>> = [];
    const port = {
      createExecution: async (i: any) => { const r = { ...i, status: "running" }; executions.push(r); return r; },
      getExecution: async () => null,
      updateExecution: async (id: string, patch: any) => { const r = executions.find((e) => e.executionId === id); Object.assign(r!, patch); return r; },
      appendNodeRun: async (i: any) => i,
      updateNodeRun: async (executionId: string, nodeId: string, patch: any) => { store.set(`${executionId}:${nodeId}`, patch); return { nodeId, ...patch }; },
      listNodeRuns: async () => [],
      listRunningExecutions: async () => [],
      listWaitingHumanExecutions: async () => [],
    } as any;
    const svc = createWorkflowExecutionService({
      port,
      nodeRunners: { script: { run: async (node: any, ctx: any) => ({ output: { val: ctx.input.num } }) }, human: { run: async () => ({ output: {} }) }, agent: { run: async () => ({ output: {} }) } } as any,
    });
    const result = await svc.startExecution({ workflowId: "wf", definition: makeDef(), input: { num: 7 } });
    expect(result.status).toBe("success");
    expect((executions[0] as any).store).toEqual({ num: 7 });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/backend && bun test features/workflow/service.test.ts`
Expected: FAIL — `Cannot find module './service.js'`

- [ ] **Step 3: 创建 service.ts**

```typescript
import type { EngineState, EngineStep, NodeRunResult, NodeContext, StoreApi, WorkflowDefinition, WorkflowNode, NodeRunner } from "@chengchenccc/workflow";
import { computeNext } from "@chengchenccc/workflow";
import type { WorkflowExecutionPort } from "./ports.js";
import type { WorkflowExecutionRow, WorkflowNodeRunRow } from "./domain.js";
import { ulid } from "@chengchenccc/id"; // or codebase's idGen; use a local ULID via crypto helper

function makeId(): string {
  // minimal ULID-ish; replace with repo's idGen helper (search `ulid()`)
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface WorkflowExecutionServiceDeps {
  port: WorkflowExecutionPort;
  nodeRunners: Record<"agent" | "script" | "human", NodeRunner>;
}

export interface WorkflowExecutionService {
  startExecution(input: { workflowId: string; definition: WorkflowDefinition; input: Record<string, unknown> }): Promise<WorkflowExecutionRow>;
  resolveHumanTask(executionId: string, nodeId: string, answer: Record<string, unknown>): Promise<WorkflowExecutionRow>;
  getExecution(executionId: string): Promise<WorkflowExecutionRow | null>;
  listNodeRuns(executionId: string): Promise<WorkflowNodeRunRow[]>;
  recover(): Promise<void>;
  dispose(): Promise<void>;
}

export function createWorkflowExecutionService(deps: WorkflowExecutionServiceDeps): WorkflowExecutionService {
  /** In-memory completions per execution (order = completion order). */
  const completions = new Map<string, Array<{ nodeId: string; output?: Record<string, unknown>; order: number; routedTo: string[] }>>();
  /** pending human answers keyed executionId:nodeId. */
  const pendingHuman = new Map<string, { resolver: (v: Record<string, unknown>) => void; node: WorkflowNode }>();

  async function toStoreApi(executionId: string, getStore: () => Record<string, unknown>): Promise<StoreApi> {
    return {
      get: (key) => getStore()[key],
      set: async (key, value) => {
        const store = getStore();
        store[key] = value;
        await deps.port.updateExecution(executionId, { store });
      },
      delete: async (key) => {
        const store = getStore();
        delete store[key];
        await deps.port.updateExecution(executionId, { store });
      },
    };
  }

  function contextOf(executionId: string, node: WorkflowNode, workflowId: string): NodeContext {
    return { executionId, nodeId: node.id, workflowId, repo: "repo" in node ? node.repo : undefined };
  }

  async function runNode(execution: WorkflowExecutionRow, node: WorkflowNode, order: number): Promise<NodeRunResult> {
    const runner = deps.nodeRunners[node.type];
    if (!runner) throw new Error(`no runner for node type ${node.type}`);
    const input = { ...(node.input ?? {}), ...execution.input }; // merge trigger (full merge handled below)
    const storeApi = await toStoreApi(execution.executionId, () => execution.store);
    const result = await runner.run(node, { input: input as Record<string, unknown>, store: storeApi, context: contextOf(execution.executionId, node, execution.workflowId) });
    return result;
  }

  async function runOneStep(execution: WorkflowExecutionRow, state: EngineState, order: number): Promise<EngineStep> {
    const step = computeNext(execution.definition, state);
    if (step.kind === "terminal") {
      await deps.port.updateExecution(execution.executionId, { status: step.exit === "failure" ? "failure" : step.exit === "success" ? "success" : "custom", exit: step.exit, terminalAt: Date.now() });
      return step;
    }
    if (step.kind === "idle") {
      // shell detects stuck: no ready and no in-flight → failure
      await deps.port.updateExecution(execution.executionId, { status: "failure", error: "stuck (no ready nodes)", terminalAt: Date.now() });
      return { kind: "terminal", exit: "failure" };
    }
    for (const ready of step.ready) {
      const node = ready.node;
      await deps.port.appendNodeRun({ executionId: execution.executionId, nodeId: node.id, status: node.type === "human" ? "waiting_human" : "running", order });
      if (node.type === "human") {
        // pause execution; wire answer later
        throw new Error("human node pause implemented in Task 5b (pendingHuman resolve flow)");
      }
      const result = await runNode(execution, node, order);
      const output = result.output ?? {};
      const completionsArr = completions.get(execution.executionId) ?? [];
      const routedTo: string[] = await deps.port.listNodeRuns(...).then(() => []);
      // compute routedTo via routeOutgoing from @chengchenccc/workflow
      const { routeOutgoing } = await import("@chengchenccc/workflow");
      const routed = routeOutgoing(node.id, execution.definition, completionsArr.map((c) => ({ nodeId: c.nodeId, output: c.output, order: c.order, routedTo: c.routedTo })), execution.store);
      completionsArr.push({ nodeId: node.id, output, order, routedTo: routed });
      completions.set(execution.executionId, completionsArr);
      await deps.port.updateNodeRun(execution.executionId, node.id, { status: "completed", output, routedTo: routed, terminalAt: Date.now() });
      // refresh execution store from port
      const fresh = await deps.port.getExecution(execution.executionId);
      if (fresh) execution.store = fresh.store;
    }
    return { kind: "run", ready: step.ready };
  }

  async function drive(execution: WorkflowExecutionRow) {
    let order = 0;
    const state: EngineState = {
      completions: (completions.get(execution.executionId) ?? []).map((c, i) => ({ nodeId: c.nodeId, output: c.output, order: i, routedTo: c.routedTo })),
      store: execution.store,
      trigger: execution.input,
    };
    for (;;) {
      const step = await runOneStep(execution, state, order);
      if (step.kind === "terminal") return;
      order += step.ready.length;
      // recompute state from completed completions
      const arr = completions.get(execution.executionId) ?? [];
      state.completions = arr.map((c, i) => ({ nodeId: c.nodeId, output: c.output, order: i, routedTo: c.routedTo }));
      state.store = execution.store;
    }
  }

  return {
    async startExecution(input) {
      const executionId = makeId();
      const row = await deps.port.createExecution({
        executionId,
        workflowId: input.workflowId,
        definition: input.definition,
        input: input.input,
        store: { ...input.input },
        status: "running",
      });
      void drive(row); // fire-and-forget; events via subscribe
      return row;
    },
    async resolveHumanTask(executionId, nodeId, answer) {
      const key = `${executionId}:${nodeId}`;
      const hang = pendingHuman.get(key);
      if (hang) hang.resolver(answer);
      const row = await deps.port.getExecution(executionId);
      return row!;
    },
    async getExecution(id) { return deps.port.getExecution(id); },
    async listNodeRuns(id) { return deps.port.listNodeRuns(id); },
    async recover() {
      // re-drive running + waiting_human executions on reboot
      for (const e of await deps.port.listRunningExecutions()) void drive(e);
    },
    async dispose() {},
  };
}
```

> 注：Task 5 的目标是**最小线性/分支成功路径**。human 挂起/恢复在 Task 5b 补。agent runner 在 Task 5b 补（enqueue+dispatch+subscribe 全生命周期）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/backend && bun test features/workflow/service.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/features/workflow/service.ts apps/backend/src/features/workflow/service.test.ts
git commit -m "feat(workflow): add workflow execution service loop"
```

---

### Task 5b: human 挂起/恢复 + agent runner

**Files:**
- Modify: `apps/backend/src/features/workflow/service.ts`
- Modify: `apps/backend/src/features/workflow/service.test.ts`

- [ ] **Step 1: 实现 human 挂起/恢复**

- human 节点进入 `waiting_human`，把 resolver 存入 `pendingHuman[executionId:nodeId]`，**不再继续 drive**。
- `resolveHumanTask(executionId, nodeId, answer)` 调 resolver；resolver 把答案作为该节点 output、算 routedTo、写入 completions，然后继续 drive。

- [ ] **Step 2: 实现 agent runner**

- agent 节点用 `agentRunService.enqueueAndAcquire({ conversationId, agentId, backendKind, mode:'normal', message, defaultModel, configRevision, idempotencyKey, ... })` 建一个 Run，`agentRunExecution.dispatch(runId)` 触发，`for await (const ev of agentRunExecution.subscribe(runId))` 等 terminal，取最终 assistant text 作为 output。
- conversationId/memberId 用确定性命名：`workflow:${executionId}:${nodeId}` / `workflow-agent:${executionId}:${nodeId}`。
- 需在 `createWorkflowExecutionService` deps 中增加 `agentRunService`、`agentRunExecution`、`resolveDefaultModel`、`convPort`、`idGen`。

- [ ] **Step 3: 补测试（agent/human 用 fake）**

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/features/workflow/service.ts apps/backend/src/features/workflow/service.test.ts
git commit -m "feat(workflow): add human pause/resume and agent node runner"
```

---

### Task 6: HTTP + bootstrap 接线

**Files:**
- Create: `apps/backend/src/features/workflow/http.ts`
- Create: `apps/backend/src/features/workflow/http.test.ts`
- Modify: `apps/backend/src/features/workflow/index.ts`
- Modify: `apps/backend/src/app.ts`
- Modify: `apps/backend/src/bootstrap/features.ts`

- [ ] **Step 1: 创建 http.ts**

```typescript
import { Elysia, t } from "elysia";
import { sseResponse } from "../../http/response.js";
import type { WorkflowExecutionService } from "./service.js";

export function workflowRoutes(deps: { workflowExecutionService: WorkflowExecutionService }): Elysia {
  const svc = deps.workflowExecutionService;
  return new Elysia()
    .post("/api/workflow-executions", async ({ body }) => {
      const def = JSON.parse(body.definition);
      const execution = await svc.startExecution({ workflowId: body.workflowId, definition: def, input: body.input ?? {} });
      return execution;
    }, {
      body: t.Object({
        workflowId: t.String({ minLength: 1 }),
        definition: t.String({ minLength: 1 }),
        input: t.Optional(t.Record(t.Unknown())),
      }),
    })
    .get("/api/workflow-executions/:executionId", async ({ params }) => {
      const row = await svc.getExecution(params.executionId);
      if (!row) throw new Error("Execution not found");
      return row;
    })
    .get("/api/workflow-executions/:executionId/events", async ({ request, params }) => {
      const stream = eventStreamFor(params.executionId, svc);
      return sseResponse(stream, (ev: { event: string; data: unknown }) => ({ id: params.executionId, event: ev.event, data: ev.data }), request.signal);
    })
    .post("/api/workflow-executions/:executionId/human-task", async ({ params, body }) => {
      const row = await svc.resolveHumanTask(params.executionId, body.nodeId, body.answer ?? {});
      return row;
    }, {
      body: t.Object({ nodeId: t.String({ minLength: 1 }), answer: t.Optional(t.Record(t.Unknown())) }),
    });
}

function eventStreamFor(executionId: string, svc: WorkflowExecutionService): AsyncIterable<{ event: string; data: unknown }> {
  return (async function* () {
    // Simplest v1: poll terminal status once per second; a full SSE event
    // bus can be layered later.
    for (;;) {
      const row = await svc.getExecution(executionId);
      if (!row) return;
      yield { event: "execution_status", data: { status: row.status, exit: row.exit, store: row.store } };
      if (row.status === "success" || row.status === "failure" || row.status === "custom") return;
      await new Promise((r) => setTimeout(r, 1000));
    }
  })();
}
```

- [ ] **Step 2: 创建 index.ts**

```typescript
export * from "./domain.js";
export * from "./ports.js";
export * from "./adapter-sqlite.js";
export * from "./node-runners.js";
export * from "./service.js";
export * from "./http.js";
```

- [ ] **Step 3: app.ts 加 FeatureSet key + .use**

在 `FeatureSet` 加 `workflowExecutions: ReturnType<typeof workflowRoutes>;`；在 `createApp` 解构并 `.use(workflowExecutions)`。

- [ ] **Step 4: bootstrap/features.ts 接线**

```typescript
// 在 installFeatures 内，agentRunExecution 创建后：
const workflowPort = createWorkflowExecutionAdapter(db);
const workflowNodeRunners = createNodeRunners({ dataDir: config.dataDir });
const workflowExecutionService = createWorkflowExecutionService({
  port: workflowPort,
  nodeRunners: workflowNodeRunners,
});
const workflowRoutes = workflowRoutes({ workflowExecutionService: workflowExecutionService });
```
并把 `workflowExecutions` 加进 `featureSet`、`workflowExecutionService` 加进 `InstalledFeatures`。在 `start()` 内 `await workflowExecutionService.recover()`；`dispose()` 内 `await workflowExecutionService.dispose()`。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/backend && bun test features/workflow/http.test.ts`
Expected: PASS（用 fake WorkflowExecutionService 验证 POST /api/workflow-executions 返回 201 行、GET 返回行）。

- [ ] **Step 6: 全量验证**

Run: `cd /root/my-agent-team && bun run typecheck`
Expected: PASS。

Run: `cd apps/backend && bun test`
Expected: 现有测试 + 新增 workflow 测试全绿。

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/features/workflow apps/backend/src/app.ts apps/backend/src/bootstrap/features.ts
git commit -m "feat(workflow): wire workflow http routes and bootstrap"
```

---

## 备注（执行注意事项）

- Task 1 migration 的 `--> statement-breakpoint` 必须保留；用 `sqlite3 apps/backend/.backend-data/backend.db` 查 `PRAGMA table_info(workflow_execution)` 确认。
- `service.ts` 的 `makeId()` 若仓库已有 `idGen`/`ulid` 辅助，改用之（搜 `idGen` / `crypto.randomUUID` / `ulid`）。
- `routeOutgoing` 需要 `completions` 为真实 CompletionRecord（含 routedTo）。Task 5 的原始代码用 `listNodeRuns(...)` 是占位，须改为从内存 `completions` 构造真实 record（plan 已注明）。
- `app.ts` / `features.ts` 改动需注意 dist 构建：改 backend 后要先 `cd apps/backend && bun run build`，web 才吃到 Eden 新类型。
- commitlint scope：新增 `workflow` 已在 Plan 1 Task 0 加入 enum。
