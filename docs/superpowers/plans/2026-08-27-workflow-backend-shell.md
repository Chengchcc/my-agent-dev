# Agentic Workflow Plan 2: backend 执行壳

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `apps/backend/src/features/workflow/` 实现 agentic workflow 执行壳：持久化 execution + node-run + pending-human、节点 runner（script/agent/human）、纯引擎驱动循环（含 human 挂起/恢复、retry→failure）、HTTP API（POST `{workflowRef, input}` + SSE 事件流 + human-task resolve）、bootstrapping 接线。

**Architecture:** 新增六边形 feature（domain/ports/adapter-sqlite/node-runners/service/http/event-bus）。消费已落地的 `@chengchenccc/workflow`。agent 节点走 `agentRunService.enqueueAndAcquire` + `agentRunExecution.dispatch/subscribe`；human 走独立 pending-human 表（不复用 `pending_action`，因为它 FK 到 agent_run 且语义是 approve/deny）；script 走 Bun 临时文件 import。

**Tech Stack:** Bun 1.3, Elysia, Drizzle ORM + SQLite, `@chengchenccc/workflow`, bun:test。spec:`docs/superpowers/specs/2026-08-27-agentic-workflow-design.md`。

**范围外（后续 plan）：** CronJob workflow target、loop 删除、编辑器 web、workflowRef→git 仓库 loader 的真实实现（本 plan 用注入的 `loadWorkflow`，测试用 stub）。

---

## 文件结构

```
apps/backend/src/features/workflow/
  domain.ts                # WorkflowExecutionRow / WorkflowNodeRunRow / WorkflowPendingHumanRow
  ports.ts                 # WorkflowExecutionPort（含 pendingHuman CRUD）
  adapter-sqlite.ts        # sqliteWorkflowExecutionAdapter(db)
  node-runners.ts          # createNodeRunners({dataDir, agentRunService}) → {script, human}; agent 由 service 内联实现
  event-bus.ts             # per-execution AsyncIterable 事件队列
  service.ts               # createWorkflowExecutionService（引擎循环 + human 恢复 + retry/failure）
  http.ts                  # workflowRoutes
  index.ts                 # barrel
  *.test.ts

apps/backend/src/infra/db/schema.ts        # + workflowExecution / workflowNodeRun / workflowPendingHuman
apps/backend/drizzle/backend/0040_workflow_execution.sql
apps/backend/drizzle/backend/meta/_journal.json
apps/backend/src/bootstrap/features.ts
apps/backend/src/app.ts
```

---

### Task 1: schema + migration

**Files:**
- Modify: `apps/backend/src/infra/db/schema.ts`
- Create: `apps/backend/drizzle/backend/0040_workflow_execution.sql`
- Modify: `apps/backend/drizzle/backend/meta/_journal.json`

- [ ] **Step 1: schema.ts 增加三表**

```typescript
export const workflowExecution = sqliteTable(
  "workflow_execution",
  {
    executionId: text("execution_id").notNull().primaryKey(),
    workflowId: text("workflow_id").notNull(),
    definition: text("definition").notNull(), // JSON: WorkflowDefinition snapshot
    input: text("input").notNull(),           // JSON: trigger input vars
    store: text("store").notNull().default("{}"),
    status: text().notNull().default("running"), // running | waiting_human | success | failure | custom
    exit: text(),
    error: text(),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    terminalAt: integer("terminal_at", { mode: "number" }),
  },
);

export const workflowNodeRun = sqliteTable(
  "workflow_node_run",
  {
    seq: integer().primaryKey({ autoIncrement: true }),
    executionId: text("execution_id").notNull().references(() => workflowExecution.executionId, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    status: text().notNull().default("running"), // running | waiting_human | completed | failed
    order: integer().notNull(),
    output: text(),       // JSON
    routedTo: text(),     // JSON string[]
    error: text(),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    terminalAt: integer("terminal_at", { mode: "number" }),
  },
  (table) => [index("idx_workflow_node_run_exec").on(table.executionId, table.seq)],
);

export const workflowPendingHuman = sqliteTable(
  "workflow_pending_human",
  {
    executionId: text("execution_id").notNull().references(() => workflowExecution.executionId, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    question: text(),
    form: text(),         // JSON Record<string, FormField>
    status: text().notNull().default("pending"), // pending | resolved
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    terminalAt: integer("terminal_at", { mode: "number" }),
  },
  (table) => [primaryKey({ columns: [table.executionId, table.nodeId] })],
);
```

- [ ] **Step 2: 创建 migration SQL**（每条间 `--> statement-breakpoint`）

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
CREATE INDEX IF NOT EXISTS idx_workflow_node_run_exec ON workflow_node_run(execution_id, seq);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS workflow_pending_human (
  execution_id text NOT NULL REFERENCES workflow_execution(execution_id) ON DELETE CASCADE,
  node_id text NOT NULL,
  question text,
  form text,
  status text NOT NULL DEFAULT 'pending',
  created_at integer NOT NULL,
  terminal_at integer,
  PRIMARY KEY (execution_id, node_id)
);
```

- [ ] **Step 3: journal 追加 idx 40**

```json
{ "idx": 40, "version": "7", "when": 1788200000000, "tag": "0040_workflow_execution", "breakpoints": true }
```

- [ ] **Step 4: 验证迁移**

Run: `cd apps/backend && bun test`（现有 schema 迁移测试会跑 0040；如无专门断言，用 `openDb(":memory:")` 后 `PRAGMA table_info(workflow_execution)` 手查）。

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/infra/db/schema.ts apps/backend/drizzle/backend/0040_workflow_execution.sql apps/backend/drizzle/backend/meta/_journal.json
git commit -m "feat(workflow): add workflow execution schema and migration"
```

---

### Task 2: domain + ports

**Files:**
- Create: `apps/backend/src/features/workflow/domain.ts`
- Create: `apps/backend/src/features/workflow/ports.ts`

- [ ] **Step 1: 创建 domain.ts**

```typescript
import type { WorkflowDefinition } from "@chengchenccc/workflow";

export type WorkflowExecutionStatus = "running" | "waiting_human" | "success" | "failure" | "custom";
export type WorkflowNodeRunStatus = "running" | "waiting_human" | "completed" | "failed";
export type WorkflowPendingHumanStatus = "pending" | "resolved";

export interface WorkflowExecutionRow {
  executionId: string;
  workflowId: string;
  definition: WorkflowDefinition;
  input: Record<string, unknown>;
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

export interface WorkflowPendingHumanRow {
  executionId: string;
  nodeId: string;
  question?: string;
  form?: Record<string, unknown>;
  status: WorkflowPendingHumanStatus;
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
  WorkflowPendingHumanRow,
} from "./domain.js";

export interface WorkflowExecutionPort {
  createExecution(input: CreateWorkflowExecutionInput): Promise<WorkflowExecutionRow>;
  getExecution(executionId: string): Promise<WorkflowExecutionRow | null>;
  updateExecution(executionId: string, patch: Partial<Pick<WorkflowExecutionRow, "status" | "exit" | "error" | "store" | "terminalAt">>): Promise<WorkflowExecutionRow | null>;
  appendNodeRun(input: AppendNodeRunInput): Promise<WorkflowNodeRunRow>;
  updateNodeRun(executionId: string, nodeId: string, patch: Partial<Pick<WorkflowNodeRunRow, "status" | "output" | "routedTo" | "error" | "terminalAt">>): Promise<WorkflowNodeRunRow | null>;
  listNodeRuns(executionId: string): Promise<WorkflowNodeRunRow[]>;
  createPendingHuman(row: WorkflowPendingHumanRow): Promise<WorkflowPendingHumanRow>;
  getPendingHuman(executionId: string, nodeId: string): Promise<WorkflowPendingHumanRow | null>;
  markPendingHumanResolved(executionId: string, nodeId: string): Promise<void>;
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
import { openDb } from "../../infra/sqlite/db.js";
import { sqliteWorkflowExecutionAdapter } from "./adapter-sqlite.js";
import type { WorkflowExecutionPort } from "./ports.js";
import type { WorkflowDefinition } from "@chengchenccc/workflow";

const db = openDb(":memory:");
const adapter: WorkflowExecutionPort = sqliteWorkflowExecutionAdapter(db);

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
  test("create execution, node runs, pending human", async () => {
    await adapter.createExecution({ executionId: "e1", workflowId: "wf", definition: def, input: {}, store: {} });
    const row = await adapter.getExecution("e1");
    expect(row?.workflowId).toBe("wf");

    const nodeRun = await adapter.appendNodeRun({ executionId: "e1", nodeId: "start", status: "completed", order: 0 });
    expect(nodeRun.nodeId).toBe("start");
    await adapter.updateNodeRun("e1", "start", { output: { ok: true }, routedTo: ["done"] });
    const runs = await adapter.listNodeRuns("e1");
    expect(runs[0]!.output).toEqual({ ok: true });
    expect(runs[0]!.routedTo).toEqual(["done"]);

    await adapter.createPendingHuman({ executionId: "e1", nodeId: "h1", question: "ok?", form: {}, status: "pending", createdAt: Date.now() });
    const ph = await adapter.getPendingHuman("e1", "h1");
    expect(ph?.status).toBe("pending");
    await adapter.markPendingHumanResolved("e1", "h1");
    expect((await adapter.getPendingHuman("e1", "h1"))?.status).toBe("resolved");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/backend && bun test features/workflow/adapter-sqlite.test.ts`
Expected: FAIL — `Cannot find module './adapter-sqlite.js'`

- [ ] **Step 3: 创建 adapter-sqlite.ts**

```typescript
import { drizzle } from "drizzle-orm/bun-sqlite";
import { and, eq } from "drizzle-orm";
import type { Database } from "bun:sqlite";
import { workflowExecution, workflowNodeRun, workflowPendingHuman } from "../../infra/db/schema.js";
import type {
  AppendNodeRunInput,
  CreateWorkflowExecutionInput,
  WorkflowExecutionRow,
  WorkflowNodeRunRow,
  WorkflowPendingHumanRow,
} from "./domain.js";
import type { WorkflowExecutionPort } from "./ports.js";

function toExec(r: typeof workflowExecution.$inferSelect): WorkflowExecutionRow {
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

function toNodeRun(r: typeof workflowNodeRun.$inferSelect): WorkflowNodeRunRow {
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

function toPending(r: typeof workflowPendingHuman.$inferSelect): WorkflowPendingHumanRow {
  return {
    executionId: r.executionId,
    nodeId: r.nodeId,
    question: r.question ?? undefined,
    form: r.form ? JSON.parse(r.form) : undefined,
    status: r.status as WorkflowPendingHumanRow["status"],
    createdAt: r.createdAt,
    terminalAt: r.terminalAt ?? undefined,
  };
}

export function sqliteWorkflowExecutionAdapter(db: Database): WorkflowExecutionPort {
  const d = drizzle(db, { schema: { workflowExecution, workflowNodeRun, workflowPendingHuman } });
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
      return toExec(row!);
    },
    async getExecution(executionId) {
      const rows = await d.select().from(workflowExecution).where(eq(workflowExecution.executionId, executionId));
      const r = rows[0];
      return r ? toExec(r) : null;
    },
    async updateExecution(executionId, patch) {
      const values: Record<string, unknown> = {};
      if (patch.status !== undefined) values.status = patch.status;
      if (patch.exit !== undefined) values.exit = patch.exit;
      if (patch.error !== undefined) values.error = patch.error;
      if (patch.store !== undefined) values.store = JSON.stringify(patch.store);
      if (patch.terminalAt !== undefined) values.terminalAt = patch.terminalAt;
      if (Object.keys(values).length > 0) await d.update(workflowExecution).set(values).where(eq(workflowExecution.executionId, executionId));
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
      return toNodeRun(row!);
    },
    async updateNodeRun(executionId, nodeId, patch) {
      const values: Record<string, unknown> = {};
      if (patch.status !== undefined) values.status = patch.status;
      if (patch.output !== undefined) values.output = patch.output ? JSON.stringify(patch.output) : null;
      if (patch.routedTo !== undefined) values.routedTo = patch.routedTo ? JSON.stringify(patch.routedTo) : null;
      if (patch.error !== undefined) values.error = patch.error;
      if (patch.terminalAt !== undefined) values.terminalAt = patch.terminalAt;
      if (Object.keys(values).length > 0) {
        await d.update(workflowNodeRun).set(values).where(and(eq(workflowNodeRun.executionId, executionId), eq(workflowNodeRun.nodeId, nodeId)));
      }
      const rows = await d.select().from(workflowNodeRun).where(and(eq(workflowNodeRun.executionId, executionId), eq(workflowNodeRun.nodeId, nodeId)));
      const r = rows[0];
      return r ? toNodeRun(r) : null;
    },
    async listNodeRuns(executionId) {
      const rows = await d.select().from(workflowNodeRun).where(eq(workflowNodeRun.executionId, executionId)).orderBy(workflowNodeRun.seq);
      return rows.map(toNodeRun);
    },
    async createPendingHuman(row) {
      const [r] = await d.insert(workflowPendingHuman).values({
        executionId: row.executionId,
        nodeId: row.nodeId,
        question: row.question ?? null,
        form: row.form ? JSON.stringify(row.form) : null,
        status: row.status,
        createdAt: row.createdAt,
      }).returning();
      return toPending(r!);
    },
    async getPendingHuman(executionId, nodeId) {
      const rows = await d.select().from(workflowPendingHuman).where(
        and(eq(workflowPendingHuman.executionId, executionId), eq(workflowPendingHuman.nodeId, nodeId)),
      );
      const r = rows[0];
      return r ? toPending(r) : null;
    },
    async markPendingHumanResolved(executionId, nodeId) {
      await d.update(workflowPendingHuman).set({ status: "resolved", terminalAt: Date.now() }).where(
        and(eq(workflowPendingHuman.executionId, executionId), eq(workflowPendingHuman.nodeId, nodeId)),
      );
    },
    async listRunningExecutions() {
      const rows = await d.select().from(workflowExecution).where(eq(workflowExecution.status, "running"));
      return rows.map(toExec);
    },
    async listWaitingHumanExecutions() {
      const rows = await d.select().from(workflowExecution).where(eq(workflowExecution.status, "waiting_human"));
      return rows.map(toExec);
    },
  };
}
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

### Task 4: event bus + node runners

**Files:**
- Create: `apps/backend/src/features/workflow/event-bus.ts`
- Create: `apps/backend/src/features/workflow/node-runners.ts`
- Create: `apps/backend/src/features/workflow/node-runners.test.ts`

- [ ] **Step 1: 创建 event-bus.ts**

```typescript
export interface WorkflowEvent {
  event: string;
  executionId: string;
  ts: number;
  data: unknown;
}

class Queue {
  private items: WorkflowEvent[] = [];
  private wake: (() => void) | null = null;
  push(ev: WorkflowEvent): void {
    this.items.push(ev);
    if (this.wake) {
      const w = this.wake;
      this.wake = null;
      w();
    }
  }
  async *consume(): AsyncIterable<WorkflowEvent> {
    for (;;) {
      while (this.items.length > 0) {
        const ev = this.items.shift()!;
        yield ev;
        if (ev.event === "execution_terminal") return;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

export class ExecutionEventBus {
  private queues = new Map<string, Queue>();
  emit(ev: WorkflowEvent): void {
    const q = this.queues.get(ev.executionId) ?? new Queue();
    this.queues.set(ev.executionId, q);
    q.push(ev);
  }
  subscribe(executionId: string): AsyncIterable<WorkflowEvent> {
    const q = this.queues.get(executionId) ?? new Queue();
    this.queues.set(executionId, q);
    return q.consume();
  }
}
```

- [ ] **Step 2: 写失败测试 node-runners.test.ts**

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

  test("human node creates pendingAction via agentRunService and uses dynamic form", async () => {
    let created: string | null = null;
    const runners = createNodeRunners({
      dataDir: ".data",
      agentRunService: {
        createPendingAction: async (_runId: string, action: { kind: string; payload: Record<string, unknown> }) => {
          created = action.kind;
          return { actionId: "a", runId: "x", kind: action.kind, payload: action.payload, status: "pending" };
        },
      } as never,
    });
    const out = await runners.human.run(
      { id: "h", type: "human", question: "static?" },
      { input: { question: "dynamic?", form: { x: { type: "string" } } }, store: {}, context: { executionId: "e", nodeId: "h", workflowId: "wf" } },
    );
    expect(created).toBe("human_task_requested");
    expect((out.output as Record<string, unknown>).question).toBe("dynamic?");
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd apps/backend && bun test features/workflow/node-runners.test.ts`
Expected: FAIL — `Cannot find module './node-runners.js'`

- [ ] **Step 4: 创建 node-runners.ts**

```typescript
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { NodeRunResult, NodeContext, ScriptContext, StoreApi, WorkflowNode, FormField } from "@chengchenccc/workflow";

export interface NodeRunnerDeps {
  dataDir: string;
  agentRunService?: {
    createPendingAction(runId: string, action: { kind: string; payload: Readonly<Record<string, unknown>> }): Promise<{ actionId: string; runId: string; kind: string; payload: Record<string, unknown>; status: string }>;
  };
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
          const mod = await import(`${file}?t=${Date.now()}-${Math.random().toString(36).slice(2)}`);
          const fn = mod.default as (ctx: ScriptContext) => unknown;
          const out = (await fn(ctx)) ?? {};
          return { output: out as Record<string, unknown> };
        } finally {
          rmSync(file, { force: true });
        }
      },
    },
    human: {
      async run(node: WorkflowNode, ctx: { input: Record<string, unknown>; store: StoreApi; context: NodeContext }): Promise<NodeRunResult> {
        if (node.type !== "human") throw new Error(`not a human node: ${node.type}`);
        if (!deps.agentRunService) throw new Error("human runner requires agentRunService");
        const question = (ctx.input.question as string | undefined) ?? node.question ?? "";
        const form = (ctx.input.form as Record<string, FormField> | undefined) ?? node.form ?? {};
        await deps.agentRunService.createPendingAction(ctx.context.executionId, {
          kind: "human_task_requested",
          payload: { executionId: ctx.context.executionId, nodeId: node.id, question, form },
        });
        return { output: { question, form } };
      },
    },
  };
}

export type NodeRunners = ReturnType<typeof createNodeRunners>;
```

> agent 节点 runner 不在这里——它需要完整 agent-run 生命周期，实现在 `service.ts`（见 Task 5 的 `runAgentNode`）。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/backend && bun test features/workflow/node-runners.test.ts`
Expected: PASS, 2 tests。

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/features/workflow/event-bus.ts apps/backend/src/features/workflow/node-runners.ts apps/backend/src/features/workflow/node-runners.test.ts
git commit -m "feat(workflow): add event bus and script/human node runners"
```

---

### Task 5: 执行 service

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

function ramPort() {
  const executions = new Map<string, any>();
  const nodeRuns: any[] = [];
  return {
    executions,
    nodeRuns,
    port: {
      createExecution: async (i: any) => { const r = { ...i, status: "running" }; executions.set(i.executionId, r); return r; },
      getExecution: async (id: string) => executions.get(id) ?? null,
      updateExecution: async (id: string, patch: any) => { const r = executions.get(id); Object.assign(r!, patch); return r; },
      appendNodeRun: async (i: any) => { const r = { seq: nodeRuns.length + 1, ...i }; nodeRuns.push(r); return r; },
      updateNodeRun: async (_e: string, nodeId: string, patch: any) => { const r = nodeRuns.find((x) => x.nodeId === nodeId); if (r) Object.assign(r, patch); return r; },
      listNodeRuns: async () => nodeRuns,
      createPendingHuman: async (r: any) => r,
      getPendingHuman: async () => null,
      markPendingHumanResolved: async () => {},
      listRunningExecutions: async () => [],
      listWaitingHumanExecutions: async () => [],
    } as any,
  };
}

describe("createWorkflowExecutionService", () => {
  test("runs a linear workflow to terminal success via runToCompletion", async () => {
    const { port } = ramPort();
    const svc = createWorkflowExecutionService({
      port,
      nodeRunners: {
        script: { run: async (node: any, ctx: any) => ({ output: { val: ctx.input.num } }) },
        human: { run: async () => ({ output: {} }) },
      } as any,
      eventBus: { emit: () => {}, subscribe: async function* () {} } as any,
      idGen: () => "e1",
    });
    const result = await svc.runToCompletion("e1", { workflowId: "wf", definition: makeDef(), input: { num: 7 } });
    expect(result.status).toBe("success");
    expect(result.exit).toBe("success");
    expect(port.getExecution("e1")).resolves.toMatchObject({ status: "success" });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/backend && bun test features/workflow/service.test.ts`
Expected: FAIL — `Cannot find module './service.js'`

- [ ] **Step 3: 创建 service.ts**

```typescript
import { computeNext, parseWorkflow, routeOutgoing, type CompletionRecord, type EngineState, type NodeContext, type NodeRunner, type NodeRunResult, type StoreApi, type WorkflowDefinition, type WorkflowNode } from "@chengchenccc/workflow";
import type { ExecutionEventBus } from "./event-bus.js";
import type { WorkflowExecutionPort } from "./ports.js";
import type { WorkflowExecutionRow, WorkflowNodeRunRow } from "./domain.js";

export interface WorkflowExecutionServiceDeps {
  port: WorkflowExecutionPort;
  nodeRunners: Partial<Record<"script" | "human", NodeRunner>>;
  eventBus: ExecutionEventBus;
  idGen: () => string;
  agentRunService?: {
    conversation: unknown;
    createPendingAction(runId: string, action: { kind: string; payload: Readonly<Record<string, unknown>> }): Promise<unknown>;
  };
  agentRunExecution?: {
    dispatch(runId: string): Promise<void>;
    subscribe(runId: string, signal?: AbortSignal): AsyncIterable<{ type: string; data?: unknown }>;
  };
  evaluateAgentPrompt?: (node: WorkflowNode, input: Record<string, unknown>, context: NodeContext) => Promise<Record<string, unknown>>;
}

export interface WorkflowExecutionService {
  runToCompletion(executionId: string, input: { workflowId: string; definition: WorkflowDefinition; input: Record<string, unknown> }): Promise<WorkflowExecutionRow>;
  startExecution(input: { workflowId: string; definition: WorkflowDefinition; input: Record<string, unknown> }): Promise<WorkflowExecutionRow>;
  resolveHumanTask(executionId: string, nodeId: string, answer: Record<string, unknown>): Promise<WorkflowExecutionRow>;
  getExecution(executionId: string): Promise<WorkflowExecutionRow | null>;
  listNodeRuns(executionId: string): Promise<WorkflowNodeRunRow[]>;
  recover(): Promise<void>;
  dispose(): Promise<void>;
}

async function runNodeWithRetry(node: WorkflowNode, run: (node: WorkflowNode) => Promise<NodeRunResult>, current: WorkflowExecutionPort, executionId: string): Promise<NodeRunResult> {
  const retry = node.retry ?? 0;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retry; attempt++) {
    try {
      return await run(node);
    } catch (err) {
      lastError = err;
      if (attempt === retry) throw err;
    }
  }
  throw lastError;
}

export function createWorkflowExecutionService(deps: WorkflowExecutionServiceDeps): WorkflowExecutionService {
  const completions = new Map<string, CompletionRecord[]>();

  function emit(executionId: string, event: string, data: unknown) {
    deps.eventBus.emit({ executionId, event, ts: Date.now(), data });
  }

  async function storeApiOf(executionId: string, getStore: () => Record<string, unknown>): Promise<StoreApi> {
    return {
      get: (key) => getStore()[key],
      set: async (key, value) => {
        const store = getStore();
        store[key] = value;
        await deps.port.updateExecution(executionId, { store });
        emit(executionId, "store_write", { key, value });
      },
      delete: async (key) => {
        const store = getStore();
        delete store[key];
        await deps.port.updateExecution(executionId, { store });
        emit(executionId, "store_write", { key, deleted: true });
      },
    };
  }

  async function runAgentNode(node: WorkflowNode, ready: { input: Record<string, unknown> }, execution: WorkflowExecutionRow): Promise<NodeRunResult> {
    if (node.type !== "agent") throw new Error(`not agent: ${node.type}`);
    if (!deps.evaluateAgentPrompt) throw new Error("agent runner requires evaluateAgentPrompt");
    const output = await deps.evaluateAgentPrompt(node, ready.input, {
      executionId: execution.executionId,
      nodeId: node.id,
      workflowId: execution.workflowId,
      repo: node.repo,
    });
    return { output };
  }

  async function executeNode(execution: WorkflowExecutionRow, node: WorkflowNode, ready: { input: Record<string, unknown> }, order: number): Promise<{ output: Record<string, unknown> } | null> {
    emit(execution.executionId, "node_started", { nodeId: node.id, order });
    await deps.port.appendNodeRun({ executionId: execution.executionId, nodeId: node.id, status: node.type === "human" ? "waiting_human" : "running", order });

    if (node.type === "start") {
      const output = { ...execution.input };
      return { output };
    }

    if (node.type === "human") {
      await deps.port.createPendingHuman({
        executionId: execution.executionId,
        nodeId: node.id,
        question: (ready.input.question as string | undefined) ?? node.question,
        form: (ready.input.form as Record<string, unknown> | undefined) ?? node.form,
        status: "pending",
        createdAt: Date.now(),
      });
      await deps.port.updateExecution(execution.executionId, { status: "waiting_human" });
      emit(execution.executionId, "human_task_requested", { nodeId: node.id, question: node.question, form: node.form });
      return null; // paused — caller stops driving
    }

    const runner = deps.nodeRunners[node.type];
    if (!runner) throw new Error(`no runner for node type ${node.type}`);
    const storeApi = await storeApiOf(execution.executionId, () => execution.store);
    const result = await runNodeWithRetry(
      node,
      (n) => runner.run(n, { input: ready.input, store: storeApi, context: { executionId: execution.executionId, nodeId: n.id, workflowId: execution.workflowId, repo: n.type === "agent" ? n.repo : undefined } }),
      deps.port,
      execution.executionId,
    );
    return { output: result.output ?? {} };
  }

  function recordCompletion(execution: WorkflowExecutionRow, node: WorkflowNode, output: Record<string, unknown>, order: number): CompletionRecord {
    const arr = completions.get(execution.executionId) ?? [];
    const routedTo = routeOutgoing(node.id, execution.definition, arr, execution.store);
    const record: CompletionRecord = { nodeId: node.id, output, order, routedTo };
    arr.push(record);
    completions.set(execution.executionId, arr);
    return record;
  }

  async function drive(execution: WorkflowExecutionRow): Promise<void> {
    const nodeRuns = await deps.port.listNodeRuns(execution.executionId);
    if (completions.get(execution.executionId) === undefined) {
      completions.set(execution.executionId, nodeRuns.map((r, i) => ({ nodeId: r.nodeId, output: r.output ?? {}, order: i, routedTo: r.routedTo ?? [] })));
    }
    let order = nodeRuns.length;
    for (;;) {
      const state: EngineState = {
        completions: completions.get(execution.executionId) ?? [],
        store: execution.store,
        trigger: execution.input,
      };
      const step = computeNext(execution.definition, state);
      if (step.kind === "terminal") break;
      if (step.kind === "idle") throw new Error("stuck: no ready nodes and no terminal");
      let paused = false;
      for (const ready of step.ready) {
        const node = ready.node;
        const res = await executeNode(execution, node, ready, order++);
        if (res === null) { paused = true; break; } // human
        const record = recordCompletion(execution, node, res.output, order - 1);
        await deps.port.updateNodeRun(execution.executionId, node.id, { status: "completed", output: record.output, routedTo: record.routedTo, terminalAt: Date.now() });
        emit(execution.executionId, "node_completed", { nodeId: node.id, output: record.output, routedTo: record.routedTo });
        const fresh = await deps.port.getExecution(execution.executionId);
        if (fresh) execution.store = fresh.store;
      }
      if (paused) return;
      emit(execution.executionId, "execution_status", { status: "running" });
    }
    await deps.port.updateExecution(execution.executionId, {
      status: stepKindStatus(execution.definition, state),
      exit: lastExit(execution.definition, state),
      terminalAt: Date.now(),
    });
    emit(execution.executionId, "execution_terminal", { exit: lastExit(execution.definition, state) });
  }

  function stepKindStatus(_def: WorkflowDefinition, _state: EngineState): "success" | "failure" | "custom" {
    // Computed in the step's terminal exit; re-derived here from the last
    // terminal exit label via a simple map. The exit label is set to
    // step.exit below in runToCompletion/startExecution wrapper.
    return "success";
  }

  function lastExit(_def: WorkflowDefinition, _state: EngineState): string {
    return "success";
  }

  async function runWithCatch(executionId: string, execute: () => Promise<void>): Promise<void> {
    try {
      await execute();
    } catch (err) {
      await deps.port.updateExecution(executionId, { status: "failure", error: (err as Error).message, terminalAt: Date.now() });
      emit(executionId, "execution_terminal", { exit: "failure", error: (err as Error).message });
    }
  }

  return {
    async runToCompletion(executionId, input) {
      const row = await deps.port.createExecution({ executionId, workflowId: input.workflowId, definition: input.definition, input: input.input, store: { ...input.input }, status: "running" });
      emit(executionId, "execution_started", {});
      await runWithCatch(executionId, () => drive(row));
      return (await deps.port.getExecution(executionId))!;
    },
    async startExecution(input) {
      const executionId = deps.idGen();
      const row = await deps.port.createExecution({ executionId, workflowId: input.workflowId, definition: input.definition, input: input.input, store: { ...input.input }, status: "running" });
      emit(executionId, "execution_started", {});
      void runWithCatch(executionId, () => drive(row));
      return row;
    },
    async resolveHumanTask(executionId, nodeId, answer) {
      const row = await deps.port.getExecution(executionId);
      if (!row) throw new Error("Execution not found");
      await deps.port.markPendingHumanResolved(executionId, nodeId);
      const arr = completions.get(executionId) ?? [];
      await deps.port.updateNodeRun(executionId, nodeId, { status: "completed", output: answer, routedTo: [], terminalAt: Date.now() });
      arr.push({ nodeId, output: answer, order: arr.length, routedTo: [] });
      completions.set(executionId, arr);
      await deps.port.updateExecution(executionId, { status: "running" });
      void runWithCatch(executionId, () => drive(row));
      return row;
    },
    async getExecution(id) { return deps.port.getExecution(id); },
    async listNodeRuns(id) { return deps.port.listNodeRuns(id); },
    async recover() {
      for (const e of await deps.port.listRunningExecutions()) void runWithCatch(e.executionId, () => drive(e));
      // waiting_human: resolver is not in memory after reboot; require a
      // new resolveHumanTask call (which drives from stored pending row).
    },
    async dispose() {},
  };
}
```

> 说明：`stepKindStatus`/`lastExit` 需要用缓存最近一次 `computeNext` 的 `step.exit`（当前简化返回 success；执行时把 terminal exit 存到一个 `Map<executionId, string>`，`drive` 末尾读它，不要重算）。`runAgentNode` 在 Task 5b 用 `agentRunService.enqueueAndAcquire` + `agentRunExecution.dispatch/subscribe` 替换 `evaluateAgentPrompt` 注入实现。
>
> **input/output schema 校验（`@chengchenccc/workflow` `validateBySchema`）**：`executeNode` 在跑节点前对 `ready.input` 做 `node.inputSchema` 校验，失败即 throw（节点失败→retry→failure）；节点返回后对 output 做 `node.outputSchema` 校验，失败同样 throw。`start`/`human` 节点也适用（human 的 output 是表单答案）。
>
> ```typescript
> import { validateBySchema } from "@chengchenccc/workflow";
> // executeNode 内，跑节点前：
> const inputErrors = node.inputSchema ? validateBySchema(ready.input, node.inputSchema) : [];
> if (inputErrors.length > 0) throw new Error(`node ${node.id} input invalid: ${inputErrors.join("; ")}`);
> // 节点返回 output 后：
> const outputErrors = node.outputSchema ? validateBySchema(result.output ?? {}, node.outputSchema) : [];
> if (outputErrors.length > 0) throw new Error(`node ${node.id} output invalid: ${outputErrors.join("; ")}`);
> ```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/backend && bun test features/workflow/service.test.ts`
Expected: PASS（linear→success）。

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/features/workflow/service.ts apps/backend/src/features/workflow/service.test.ts
git commit -m "feat(workflow): add workflow execution service loop"
```

---

### Task 5b: human 恢复 + agent 真 runner

**Spike 结论（已实测 rpc-fixture）**：`agentRunExecution.subscribe(runId)` 流的事件类型为 `status`（payload 带 `status: "agent_start" | "completed"`）、`text_delta`。**terminal 判定** = `ev.type === "status" && ["completed","failed","aborted","commit_failed"].includes(ev.status)`。**最终答复** = `run.terminalResult.messages` 数组最后一个 `role==="assistant"` 的 `.text`（fixture 形状 `{status, messages:[{role,text}]}`）。`enqueueAndAcquire` 的 `backendKind: "oma"`、`defaultModel: {backendKind, modelId}`、`configRevision` 数字。

**Files:**
- Modify: `apps/backend/src/features/workflow/service.ts`
- Modify: `apps/backend/src/features/workflow/service.test.ts`

- [ ] **Step 0: 修 Task 5 的 terminal 退出 hack**

删除 `stepKindStatus`/`lastExit` 两个恒返回 success 的函数，`drive` 末尾直接用 `computeNext` 返回的 `step.exit`：

```typescript
// in drive(), when step.kind === "terminal":
await deps.port.updateExecution(execution.executionId, {
  status: exitStatus(step.exit),
  exit: step.exit,
  terminalAt: Date.now(),
});
emit(execution.executionId, "execution_terminal", { exit: step.exit });
return;

function exitStatus(exit: string): "success" | "failure" | "custom" {
  if (exit === "failure") return "failure";
  if (exit === "success") return "success";
  return "custom";
}
```

- [ ] **Step 1: human 挂起→恢复正确续跑**

`drive` 开头重建 completions 改为**只取 `status==="completed"` 的行**（不把 `waiting_human`/`running` 当已完节点）：

```typescript
const nodeRuns = await deps.port.listNodeRuns(execution.executionId);
if (completions.get(execution.executionId) === undefined) {
  const done = nodeRuns.filter((r) => r.status === "completed");
  completions.set(
    execution.executionId,
    done.map((r, i) => ({ nodeId: r.nodeId, output: r.output ?? {}, order: i, routedTo: r.routedTo ?? [] })),
  );
}
```

`resolveHumanTask` 改为无状态、从 DB 续跑（不在内存 resolver）：

```typescript
async resolveHumanTask(executionId, nodeId, answer) {
  const row = await deps.port.getExecution(executionId);
  if (!row) throw new HttpError(404, "Execution not found");
  const pending = await deps.port.getPendingHuman(executionId, nodeId);
  if (!pending) throw new HttpError(404, "Pending human task not found");
  if (pending.status === "resolved") throw new HttpError(409, "Human task already resolved");

  // build completions from DB (completed only), then compute routedTo from
  // the ACTUAL prior completions (not empty []).
  const done = (await deps.port.listNodeRuns(executionId)).filter((r) => r.status === "completed");
  const arr = done.map((r, i) => ({ nodeId: r.nodeId, output: r.output ?? {}, order: i, routedTo: r.routedTo ?? [] }));
  const routedTo = routeOutgoing(nodeId, row.definition, arr, row.store);
  await deps.port.markPendingHumanResolved(executionId, nodeId);
  await deps.port.updateNodeRun(executionId, nodeId, { status: "completed", output: answer, routedTo, terminalAt: Date.now() });
  arr.push({ nodeId, output: answer, order: arr.length, routedTo });
  completions.set(executionId, arr);
  row.store = (await deps.port.getExecution(executionId))!.store;
  await deps.port.updateExecution(executionId, { status: "running" });
  void runWithCatch(executionId, () => drive(row));
  return row;
}
```

`recover()` 对 `waiting_human` **不自动续跑**——等待新的 `resolveHumanTask`（其从 DB 重建，故无需内存 resolver）。对 `running` 自动 `drive`。

- [ ] **Step 2: agent 真 runner（spike 确认的精确实现）**

在 `WorkflowExecutionServiceDeps` 增加：`agentRunService`、`agentRunExecution`、`convPort`、`resolveDefaultModel`、`resolveRepoWorkspace`，删掉 `evaluateAgentPrompt`。实现：

```typescript
async function runAgentNode(node: WorkflowNode, ready: { input: Record<string, unknown> }, execution: WorkflowExecutionRow): Promise<NodeRunResult> {
  if (node.type !== "agent") throw new Error(`not agent: ${node.type}`);
  if (!deps.agentRunService || !deps.agentRunExecution || !deps.convPort || !deps.resolveDefaultModel) {
    throw new Error("agent runner requires agentRunService/agentRunExecution/convPort/resolveDefaultModel");
  }
  const agentId = node.agentId ?? "";
  if (!agentId) throw new Error("agent node requires agentId");
  const conversationId = `workflow:${execution.executionId}:${node.id}`;
    const prompt = buildAgentPrompt(node, ready.input, execution.store, node.output);


  if (!deps.convPort.getConversation(conversationId)) {
    try { deps.convPort.createConversation({ conversationId, agentId, origin: "workflow", createdAt: Date.now() }); } catch { /* concurrent */ }
  }

  const defaultModel = await deps.resolveDefaultModel(agentId);
  const workspace = node.repo ? await deps.resolveRepoWorkspace(node.repo, agentId) : undefined;
  const acquired = await deps.agentRunService.enqueueAndAcquire({
    conversationId,
    agentId,
    backendKind: "oma",
    mode: "normal",
    message: { role: "user", text: prompt },
    defaultModel,
    configRevision: 1, // spike confirmed; real value from agent configRevision in follow-up
    idempotencyKey: `wf:${execution.executionId}:${node.id}`,
    ...(workspace ? { workspace } : {}),
  });
  const runId = acquired.run?.runId;
  if (!runId) throw new Error("agent run not acquired");

  emit(execution.executionId, "node_agent_started", { nodeId: node.id, runId });
  await deps.agentRunExecution.dispatch(runId);
  for await (const ev of deps.agentRunExecution.subscribe(runId)) {
    if (ev.type === "status" && ["completed", "failed", "aborted", "commit_failed"].includes((ev as { status?: string }).status)) {
      const run = await deps.agentRunService.getRun(runId);
      if (!run || run.status !== "completed") throw new Error(`agent run ${runId} ended ${run?.status ?? "unknown"}`);
      
  const output = extractOutput(run.terminalResult, node.output);
  emit(execution.executionId, "node_agent_completed", { nodeId: node.id, runId });
  return { output };

    }
  }
  throw new Error(`agent run ${runId} subscribe returned without terminal`);
}


function extractFinalText(outcome: unknown): string {
  const o = outcome as { messages?: Array<{ role?: string; text?: string }> } | null;
  const last = o?.messages?.slice().reverse().find((m) => m.role === "assistant");
  return last?.text ?? "";
}

/** 解析 agent node 的结构化 output。
 *  - 若节点声明了 output 类型提示：强制模型返回 JSON，解析失败 = 节点失败（触发 retry→failure）。
 *  - 未声明 output：文本兜底为 { text }。 */
function extractOutput(outcome: unknown, outputHint?: Record<string, string>): Record<string, unknown> {
  const text = extractFinalText(outcome);
  if (!text) return outputHint ? {} : { text: "" };
  const parsed = tryParseJsonObject(text);
  if (parsed) return parsed;
  if (outputHint) throw new Error("agent node output must be a JSON object matching declared output hints");
  return { text };
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}
```

`buildAgentPrompt(node, input, store, outputHint)` = 把 `node.prompt` 里的 `{{...}}` 占位换成 `input`/`store` 值；当 `outputHint` 非空时，在 prompt 末尾注入：

```
你的最终答复必须是一个 JSON 对象，包含字段：${Object.keys(outputHint).join(", ")}。
可选项：nextNode(string)。
不要输出任何其他文字。
```

v1 可先只把 `input` 序列化拼到 prompt 末尾；`outputHint` 来自节点 `output` 类型提示。

`executeNode` 的 agent 分支改为：

```typescript
if (node.type === "agent") {
  const result = await runAgentNode(node, ready, execution);
  return { output: result.output ?? {} };
}
```

- [ ] **Step 3: 补测试（agent 用 fake）**

```typescript
test("agent node runs a child run and extracts text output", async () => {
  const { port } = ramPort();
  const svc = createWorkflowExecutionService({
    port,
    nodeRunners: { script: { run: async () => ({ output: {} }) }, human: { run: async () => ({ output: {} }) } } as any,
    eventBus: { emit: () => {}, subscribe: async function* () {} } as any,
    idGen: () => "e1",
    agentRunService: {
      enqueueAndAcquire: async () => ({ acquired: true, run: { runId: "r1" } }),
      getRun: async () => ({ status: "completed", terminalResult: { status: "completed", messages: [{ role: "assistant", text: "PONG" }] } }),
    } as any,
    agentRunExecution: {
      dispatch: async () => {},
      subscribe: async function* () { yield { type: "status", status: "completed" }; },
    } as any,
    convPort: { getConversation: () => null, createConversation: () => {} } as any,
    resolveDefaultModel: async () => ({ backendKind: "oma", modelId: "x" }),
    resolveRepoWorkspace: async () => undefined,
  });
  const def = makeAgentDef();
  const result = await svc.runToCompletion("e1", { workflowId: "wf", definition: def, input: {} });
  expect(result.status).toBe("success");
  // assert the agent node_run output.text === "PONG" via port.listNodeRuns
  const runs = await port.listNodeRuns("e1");
  expect(runs.find((r: any) => r.nodeId === "s")!.output).toEqual({ text: "PONG" });
});

function makeAgentDef(): WorkflowDefinition {
  return {
    version: 1, id: "wf",
    nodes: [
      { id: "start", type: "start" },
      { id: "s", type: "agent", agentId: "ag-1" },
      { id: "done", type: "end", status: "success" },
    ],
    edges: [{ from: "start", to: "s" }, { from: "s", to: "done" }],
  };
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/features/workflow/service.ts apps/backend/src/features/workflow/service.test.ts
git commit -m "feat(workflow): add human resume and agent node runner"

---

### Task 6: HTTP + bootstrap 接线

**Files:**
- Create: `apps/backend/src/features/workflow/http.test.ts`
- Create: `apps/backend/src/features/workflow/http.ts`
- Modify: `apps/backend/src/features/workflow/index.ts`
- Modify: `apps/backend/src/app.ts`
- Modify: `apps/backend/src/bootstrap/features.ts`

- [ ] **Step 1: 创建 http.ts**

```typescript
import { Elysia, t } from "elysia";
import { HttpError } from "../../infra/errors.js";
import { sseResponse } from "../../http/response.js";
import type { WorkflowExecutionService } from "./service.js";

export interface WorkflowRef {
  repo: string;
  path: string;
}

export function workflowRoutes(deps: {
  workflowExecutionService: WorkflowExecutionService;
  loadWorkflow: (ref: WorkflowRef) => Promise<string>; // returns DSL JSON string
}): Elysia {
  const svc = deps.workflowExecutionService;
  const app = new Elysia();
  app.post("/api/workflow-executions", async ({ body }) => {
    const ref: WorkflowRef = { repo: body.workflowRef.repo, path: body.workflowRef.path };
    const raw = await deps.loadWorkflow(ref);
    const definition = JSON.parse(raw) as Parameters<typeof svc.startExecution>[0]["definition"];
    const execution = await svc.startExecution({ workflowId: `${ref.repo}/${ref.path}`, definition, input: body.input ?? {} });
    return execution;
  }, {
    body: t.Object({
      workflowRef: t.Object({ repo: t.String({ minLength: 1 }), path: t.String({ minLength: 1 }) }),
      input: t.Optional(t.Record(t.String(), t.Unknown())),
    }),
  });
  app.get("/api/workflow-executions/:executionId", async ({ params }) => {
    const row = await svc.getExecution(params.executionId);
    if (!row) throw new HttpError(404, "Execution not found");
    return row;
  });
  app.get("/api/workflow-executions/:executionId/events", async ({ request, params }) => {
    const stream = await svc.subscribeEvents(params.executionId, request.signal);
    return sseResponse(stream, (ev) => ({ id: params.executionId, event: ev.event, data: ev.data }), request.signal);
  });
  app.post("/api/workflow-executions/:executionId/human-task", async ({ params, body }) => {
    const row = await svc.resolveHumanTask(params.executionId, body.nodeId, body.answer ?? {});
    return row;
  }, {
    body: t.Object({ nodeId: t.String({ minLength: 1 }), answer: t.Optional(t.Record(t.String(), t.Unknown())) }),
  });
  return app;
}
```

> `svc.subscribeEvents(executionId, signal)` 需要加在 `WorkflowExecutionService` 上：返回 `deps.eventBus.subscribe(executionId)` 的 AsyncIterable（Task 5 已建 event bus）。

- [ ] **Step 2: 创建 index.ts**

```typescript
export * from "./domain.js";
export * from "./ports.js";
export * from "./adapter-sqlite.js";
export * from "./event-bus.js";
export * from "./node-runners.js";
export * from "./service.js";
export * from "./http.js";
```

- [ ] **Step 3: app.ts 加 FeatureSet key + .use**

- [ ] **Step 4: bootstrap/features.ts 接线**（在 `agentRunExecution` 之后）

```typescript
const workflowPort = sqliteWorkflowExecutionAdapter(db);
const workflowNodeRunners = createNodeRunners({ dataDir: config.dataDir, agentRunService });
const workflowEventBus = new ExecutionEventBus();
const workflowService = createWorkflowExecutionService({
  port: workflowPort,
  nodeRunners: workflowNodeRunners,
  eventBus: workflowEventBus,
  idGen: ulid,
});
const workflowApp = workflowRoutes({
  workflowExecutionService: workflowService,
  loadWorkflow: (ref) => loadWorkflowDefinition(ref), // 真实 git loader 在后续 plan 实现
});
```
- 把 `workflowExecutions: workflowApp` 加进 `featureSet`；`workflowService` 加进 `InstalledFeatures`；`start()` 内 `await workflowService.recover()`；`dispose()` 内 `await workflowService.dispose()`。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/backend && bun test features/workflow/http.test.ts`
Expected: PASS（fake service + fake loadWorkflow 验证 POST/GET/SSE/human-task）。

- [ ] **Step 6: 全量验证**

```bash
cd apps/backend && bun run build && cd /root/my-agent-team && bun run typecheck && cd apps/backend && bun test
```
Expected: typecheck 全绿、backend 测试全绿。

> 注意：从仓库根跑，不要硬编码 `/root/my-agent-team`——写 `bun run typecheck`（在仓库根执行）。

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/features/workflow apps/backend/src/app.ts apps/backend/src/bootstrap/features.ts
git commit -m "feat(workflow): wire workflow http routes and bootstrap"
```

---

## 备注（执行注意事项）

- **迁移**：0040 的 `--> statement-breakpoint` 必须保留；用 `openDb(":memory:")` + `PRAGMA table_info` 验证三表。
- **service 核心**：`drive` 必须用 `ready.input`（全局合并），`start` 不调 runner，`end` 由 `computeNext` terminal 短路；human 暂停时 `drive` 结束、`resolveHumanTask` 重新 drive。
- **recover**：从 `listNodeRuns` 重建 completions（只取 status==="completed" 的行作为 CompletionRecord），重启后不重跑已完成节点。
- **错误/重试**：`runNodeWithRetry` 包住节点执行；`runWithCatch` 把未捕获 rejection 收敛到 failure。
- **workflowRef vs inline**：遵循 spec——POST 收 `{workflowRef, input}`，`loadWorkflow` 解析 DSL 并 `parseWorkflow` 校验；不要内联 definition。
- **human 动态表单**：runner 优先取 `ctx.input.form/question`（上游 agent 输出），否则回退 `node.form/question`。
- **SSE**：用 `ExecutionEventBus` 发 spec 事件（execution_started/node_started/node_completed/store_write/human_task_requested/execution_terminal），不要 1 秒轮询。
- commitlint scope `workflow` 已在 Plan 1 Task 0 入 enum。
