# Agentic Workflow Plan 4: 编辑器 v2 收口（视觉 + 交互 + Chat LLM）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Plan 3 编辑器从"功能骨架"升级为真正可用的 v2：Blueprint 深色视觉、React Flow 交互编辑（拖拽/连边/删节点/节点面板/边条件）、Chat 让 agent 生成 DSL patch、**execution 时间旅行 trace**（可拖时间轴回放每刻画布状态/store 内容/事件日志）。**不做 workflow 仓库 git 化**——git loader/commit 留到后面含 agent workspace git 化的 scope。

**Architecture:** 延续"**DSL 唯一真相源，RF 是派生视图**"约定。RF 事件（`onConnect`/`onNodesDelete`/`onNodeDragStop`）**直接改 DSL state**，坐标不写回 DSL（`layeredLayout` 重算）。Chat LLM 走新后端 `POST /api/workflow-definitions/:id/chat-patch`（复用 agent-run 全生命周期），返回完整 DSL patch，用户 Apply。

**Tech Stack:** Next.js 15, React 19, `@xyflow/react`, `@monaco-editor/react`, `@chengchenccc/workflow`, Elysia, bun:test。spec:`docs/superpowers/specs/2026-08-27-agentic-workflow-design.md`。

**范围外（后续 scope）：** workflow git 化（含 agent workspace git 化）、CronJob workflow target、loop 删除。

---

## 文件结构

```
apps/web/src/app/globals.css                       # + Blueprint CSS 变量/网格/字体变量
apps/web/src/app/(main)/layout.tsx                 # + next/font 引入(Bricolage/IBM Plex Mono/Sora)
apps/web/src/components/workflow/workflow-node.tsx # RF 自定义 node（类型色带）
apps/web/src/components/workflow/WorkflowCanvas.tsx  # + nodeTypes、onConnect/onNodesDelete/onNodeDragStop、edge click
apps/web/src/components/workflow/AgenticWorkflowEditor.tsx # + DSL 易变函数 (addNode/addEdge/deleteNode/updateEdgeWhen)、节点面板
apps/web/src/components/workflow/NodePalette.tsx   # 节点创建面板
apps/web/src/components/workflow/EdgePropertyPanel.tsx # 边 when 编辑器
apps/web/src/components/workflow/ChatPanel.tsx     # + 调 chat-patch、 Apply patch
apps/backend/src/features/workflow/http.ts         # + POST /api/workflow-definitions/:id/chat-patch
apps/backend/src/features/workflow/service.ts      # + chatPatch 依赖 (agent-run 执行)
apps/backend/src/features/workflow/http.test.ts    # + chat-patch 测试

apps/backend/src/infra/db/schema.ts                        # + workflowExecutionEvent 表
apps/backend/drizzle/backend/0041_workflow_execution_event.sql
apps/backend/src/features/workflow/ports.ts              # + appendEvent/listExecutionEvents
apps/backend/src/features/workflow/adapter-sqlite.ts     # + 实现事件持久化
apps/backend/src/features/workflow/service.ts            # + emit 持久化到事件表 + getExecutionTrace
apps/backend/src/features/workflow/http.ts               # + GET /api/workflow-executions/:id/trace
apps/web/src/components/workflow/ExecutionTraceView.tsx  # 时间旅行 trace 视图

apps/web/src/app/(main)/agentic-workflow/[workflowId]/page.tsx # 不变
```

---

### Task 1: Blueprint 视觉收口

**Files:**
- Modify: `apps/web/src/app/globals.css`
- Modify: `apps/web/src/app/(main)/layout.tsx`
- Create: `apps/web/src/components/workflow/workflow-node.tsx`

- [ ] **Step 1: globals.css 加 CSS 变量（蓝图基调）**

```css
:root {
  --wf-canvas-bg: #0b0e14;
  --wf-panel-bg: #0f172a;
  --wf-input-bg: #1e293b;
  --wf-node-bg: #111827;
  --wf-node-border: #1f2937;
  --wf-node-text: #e5e7eb;
  --wf-grid-line: rgba(56, 189, 248, 0.07);
  --wf-grid-strong: rgba(56, 189, 248, 0.14);
  --wf-accent: #f59e0b;         /* amber: active/run/save */
  --wf-info: #38bdf8;           /* cyan: info/motion */
  --wf-color-start: #34d399;    /* emerald */
  --wf-color-end: #fb7185;      /* rose */
  --wf-color-agent: #38bdf8;    /* cyan */
  --wf-color-script: #f59e0b;   /* amber */
  --wf-color-human: #a78bfa;    /* violet */
}
```

- [ ] **Step 2: layout.tsx 引入字体**

```tsx
import { Bricolage_Grotesque, IBM_Plex_Mono, Sora } from "next/font/google";
const display = Bricolage_Grotesque({ subsets: ["latin"] });
const mono = IBM_Plex_Mono({ weight: "400", subsets: ["latin"] });
const body = Sora({ weight: "400", subsets: ["latin"] });
// html className={`${display.variable} ${mono.variable} ${body.variable}`}
// globals.css: :root { --font-display / --font-mono / --font-body }
```

- [ ] **Step 3: workflow-node.tsx（RF 自定义节点）**

```tsx
"use client";
import { Handle, Position, type NodeProps } from "@xyflow/react";

const typeColor: Record<string, string> = {
  start: "var(--wf-color-start)",
  end: "var(--wf-color-end)",
  agent: "var(--wf-color-agent)",
  script: "var(--wf-color-script)",
  human: "var(--wf-color-human)",
};

export function WorkflowNodeCard({ id, data, selected }: NodeProps) {
  const t = (data as { type?: string }).type ?? "script";
  return (
    <div style={{ width: 260, height: 100, background: "var(--wf-node-bg)", border: `1px solid ${selected ? "var(--wf-accent)" : "var(--wf-node-border)"}`, borderRadius: 12, position: "relative" }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, borderRadius: "12px 12px 0 0", background: typeColor[t] ?? "var(--wf-info)" }} />
      <div style={{ padding: "16px 12px 0" }}>
        <div style={{ color: "var(--wf-node-text)", fontSize: 14, fontWeight: 600 }}>{data.label as string}</div>
        <div style={{ color: "#94a3b8", fontSize: 12 }}>{t}</div>
      </div>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
```

- [ ] **Step 4: WorkflowCanvas.tsx 挂 nodeTypes + 蓝图背景**

```tsx
import { Background, BackgroundVariant, ReactFlow, ... } from "@xyflow/react";
import { WorkflowNodeCard } from "./workflow-node";

const nodeTypes = { default: WorkflowNodeCard };
// ReactFlow: nodeTypes={nodeTypes}, 外层 div style={{ background: "var(--wf-canvas-bg)" }}
// <Background variant={BackgroundVariant.Lines} gap={24} size={1} color="var(--wf-grid-line)" />
```

- [ ] **Step 5: typecheck + lint**

Run: `cd apps/web && bun run typecheck && bun run lint`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/globals.css "apps/web/src/app/(main)/layout.tsx" apps/web/src/components/workflow/workflow-node.tsx apps/web/src/components/workflow/WorkflowCanvas.tsx
git commit -m "feat(web): blueprint visual system for workflow editor"
```

---

### Task 2: RF 交互编辑（拖拽/连边/删节点/节点面板/边条件）

**Files:**
- Create: `apps/web/src/components/workflow/NodePalette.tsx`
- Create: `apps/web/src/components/workflow/EdgePropertyPanel.tsx`
- Modify: `apps/web/src/components/workflow/AgenticWorkflowEditor.tsx`
- Modify: `apps/web/src/components/workflow/WorkflowCanvas.tsx`

- [ ] **Step 1: AgenticWorkflowEditor 加 DSL 易变函数**

```tsx
import type { WorkflowDefinition, WorkflowNode } from "@chengchenccc/workflow";

function addNode(def: WorkflowDefinition, node: WorkflowNode): WorkflowDefinition {
  return { ...def, nodes: [...def.nodes, node] };
}
function addEdge(def: WorkflowDefinition, from: string, to: string): WorkflowDefinition {
  if (def.edges.some((e) => e.from === from && e.to === to)) return def;
  return { ...def, edges: [...def.edges, { from, to }] };
}
function deleteNode(def: WorkflowDefinition, id: string): WorkflowDefinition {
  return {
    ...def,
    nodes: def.nodes.filter((n) => n.id !== id),
    edges: def.edges.filter((e) => e.from !== id && e.to !== id),
  };
}
function updateEdgeWhen(def: WorkflowDefinition, edgeId: string, when: unknown): WorkflowDefinition {
  return { ...def, edges: def.edges.map((e) => (e.id === edgeId ? { ...e, when } : e)) };
}
```

- [ ] **Step 2: 节点默认配置（NodePalette.tsx）**

```tsx
const DEFAULT_NODE: Record<string, WorkflowNode> = {
  agent: { id: "", type: "agent", agentId: "", prompt: "" },
  script: { id: "", type: "script", code: "export default async () => ({})" },
  human: { id: "", type: "human", question: "" },
  end: { id: "", type: "end", status: "success" },
};

export function NodePalette({ onAdd }: { onAdd: (type: string) => void }) {
  return (
    <div className="flex gap-2 border-b p-2">
      {Object.keys(DEFAULT_NODE).map((t) => (
        <button key={t} className="rounded border px-2 py-1 text-xs" onClick={() => onAdd(t)}>{t}</button>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: AgenticWorkflowEditor 接交互**

```tsx
function makeNodeId(base: string): string {
  return `${base}-${Math.random().toString(36).slice(2, 7)}`;
}
// onAdd(type): const id = makeNodeId(type); setDefinition(addNode(def!, { ...DEFAULT_NODE[type], id }));
// onConnect({source,target}): setDefinition(addEdge(def!, source!, target!));
// onNodesDelete(nodes): setDefinition(deleteNode(def!, nodes[0]!.id));
// WorkflowCanvas props add: onConnect, onEdgesDelete? , onNodeDragStop ignored, onEdgeClick
```

- [ ] **Step 4: WorkflowCanvas.tsx 开交互 + 边点选**

```tsx
<ReactFlow
  nodes={nodes}
  edges={edges}
  nodesDraggable
  nodesConnectable
  onConnect={onConnect}
  onNodesDelete={(ns) => ns.forEach((n) => onNodeDelete?.(n.id))}
  onEdgeClick={(_, e) => onEdgeSelect?.(e.id)}
  ...
>
```

- [ ] **Step 5: EdgePropertyPanel.tsx**

```tsx
"use client";
import { useState } from "react";

export function EdgePropertyPanel({
  edgeId,
  definition,
  onChange,
}: {
  edgeId: string;
  definition: any;
  onChange: (def: any) => void;
}) {
  const edge = definition.edges.find((e: any) => e.id === edgeId);
  const [when, setWhen] = useState<string>(edge?.when ? JSON.stringify(edge.when, null, 2) : "");
  if (!edge) return null;
  return (
    <div className="space-y-3 p-4">
      <h3 className="text-sm font-semibold">Edge: {edge.from} → {edge.to}</h3>
      <label className="block text-xs">when (JSONLogic)</label>
      <textarea className="w-full rounded border p-1 font-mono" rows={6} value={when} onChange={(e) => setWhen(e.target.value)} />
      <button className="w-full rounded bg-slate-800 px-3 py-1 text-white" onClick={() => {
        try { onChange({ ...definition, edges: definition.edges.map((e: any) => e.id === edgeId ? { ...e, when: when.trim() ? JSON.parse(when) : undefined } : e) }); }
        catch { alert("Invalid JSONLogic JSON"); }
      }}>Apply</button>
    </div>
  );
}
```

- [ ] **Step 6: 侧栏接 edge 选中**

`AgenticWorkflowEditor` 增加 `activeEdgeId`；选中边时 `tab` 切到 `attrs`，侧栏显示 `EdgePropertyPanel`。

- [ ] **Step 7: typecheck + lint + 保存校验**

Run: `cd apps/web && bun run typecheck && bun run lint`
Expected: PASS。DslEditorPanel 的 Apply/Save 已过 `parseWorkflow`，交互编辑保存同样过。

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/workflow/NodePalette.tsx apps/web/src/components/workflow/EdgePropertyPanel.tsx apps/web/src/components/workflow/AgenticWorkflowEditor.tsx apps/web/src/components/workflow/WorkflowCanvas.tsx
git commit -m "feat(web): interactive workflow editing"
```

---

### Task 3: Chat LLM 生成 DSL patch（做成 skill）

**Files:**
- Create: `skills/agentic-workflow-dsl/SKILL.md`
- Modify: `apps/backend/src/features/workflow/http.ts`
- Modify: `apps/backend/src/features/workflow/service.ts`
- Modify: `apps/backend/src/features/workflow/http.test.ts`
- Modify: `apps/web/src/components/workflow/ChatPanel.tsx`
- Modify: `apps/web/src/lib/api.ts`

- [ ] **Step 1: 创建 `skills/agentic-workflow-dsl/SKILL.md`**

把"如何生产/修改 agentic workflow DSL"沉淀成可复用技能，内容覆盖：

```markdown
---
name: agentic-workflow-dsl
description: Author or modify an Agentic Workflow DSL (*.workflow.json). Use when asked to create/edit a workflow graph, node, edge condition, or metadata.
---

# Agentic Workflow DSL

## Shape (must be valid per `parseWorkflow`)

```jsonc
{
  "version": 1,
  "id": "oncall-triage",
  "meta": { "name": "…", "description": "…", "tags": ["…"], "status": "draft|active|archived", "owner": "…", "updatedBy": "…" },
  "input": { "issueUrl": "string" },
  "nodes": [ … ],
  "edges": [ … ]
}
```

## Node types

| type | required | notes |
|---|---|---|
| start | — | entry; output = trigger vars |
| end | `status` | success/failure/custom; multi-exit |
| agent | `agentId` OR (`model`+`prompt`) | may return `nextNode` |
| script | `code` | Bun TS default export; optional `timeoutMs` |
| human | `form`/`question` | ask-user; answer = output; timeoutMs |

Each node may carry optional `inputSchema`/`outputSchema` (JSON Schema subset).

## Edges

- `{ from, to, when? }`, `when` is JSONLogic **subset** (`{"==": [{"var":"node.output.x"}, "high"]}`).
- Multi-true edges = parallel fan-out; author must keep branches exclusive.
- Agent may return `nextNode` to override static edges.

## Rules (violations = `parseWorkflow` rejects)

- exactly one `start`; node ids `/^[a-zA-Z0-9_-]+$/`, unique; acyclic.
- edges reference existing node ids; agent nextNode must target an edge.
- output/input schemas use JSON Schema subset (type/properties/required/enum/items/min/max).

## Output contract

When asked to author/edit, respond with **the entire updated DSL as a single JSON object** (no markdown fence, no explanation). The caller parses it and applies as a patch.
```

- [ ] **Step 2: backend chatPatch 接 skill roots**

`createWorkflowExecutionService` deps 加 `workflowDslSkillDir?: string`；`chatPatch(workflowId, definition, instruction)` 走 agent-run：
- `enqueueAndAcquire` 时 `skillRoots: [workflowDslSkillDir]`（像 Loop 的 `builtinSkillsDir`）
- prompt = "当前 DSL: <JSON>
需求: <instruction>
按 agentic-workflow-dsl skill 返回完整更新后的 DSL JSON"
- `subscribe` 到 terminal → `extractOutput(terminalResult, null)` 取 JSON → `parseWorkflow` 校验 → 返回 `{ definition }`

- [ ] **Step 3: http.ts 加 `POST /api/workflow-definitions/:workflowId/chat-patch`**

```typescript
app.post("/api/workflow-definitions/:workflowId/chat-patch", async ({ params, body }) => {
  const raw = await Bun.file(join(dir, `${params.workflowId}.workflow.json`)).text();
  const definition = JSON.parse(raw);
  return await svc.chatPatch(params.workflowId, definition, body.instruction);
}, {
  body: t.Object({ instruction: t.String({ minLength: 1 }) }),
});
```

- [ ] **Step 4: bootstrap 接 `workflowDslSkillDir`**

`workflowDslSkillDir: join(config.dataDir, "skills/agentic-workflow-dsl")` 或指向 repo `skills/agentic-workflow-dsl`。真实路径按技能安装 dir。

- [ ] **Step 5: web api.ts + ChatPanel**

```typescript
chatPatchWorkflow: (workflowId: string, instruction: string) =>
  unwrap(client.api["workflow-definitions"]({ workflowId })["chat-patch"].post({ instruction })),
```

ChatPanel：textarea 输入 → `chatPatchWorkflow` → 显示返回 `{definition}` → `[Apply patch]` → `onChange(parsed)`；`[Reject]` 清空。

- [ ] **Step 6: http.test.ts 补 chat-patch 测试（fake service 返回 patch）**

- [ ] **Step 7: 全量验证**

Run: `cd apps/backend && bun test src/features/workflow && cd ../web && bun run typecheck && bun run lint`
Expected: PASS。

- [ ] **Step 8: Commit**

```bash
git add skills/agentic-workflow-dsl apps/backend/src/features/workflow apps/web/src/components/workflow/ChatPanel.tsx apps/web/src/lib/api.ts
git commit -m "feat(workflow): chat llm uses workflow dsl skill to generate patches"
```


### Task 4: Execution 时间旅行 trace

**Files:**
- Modify: `apps/backend/src/infra/db/schema.ts`
- Create: `apps/backend/drizzle/backend/0041_workflow_execution_event.sql`
- Modify: `apps/backend/src/features/workflow/ports.ts`
- Modify: `apps/backend/src/features/workflow/adapter-sqlite.ts`
- Modify: `apps/backend/src/features/workflow/service.ts`
- Modify: `apps/backend/src/features/workflow/http.ts`
- Create: `apps/web/src/components/workflow/ExecutionTraceView.tsx`
- Modify: `apps/web/src/lib/api.ts`

- [ ] **Step 1: schema + migration 持久化 execution 事件**

```typescript
export const workflowExecutionEvent = sqliteTable(
  "workflow_execution_event",
  {
    seq: integer().primaryKey({ autoIncrement: true }),
    executionId: text("execution_id").notNull().references(() => workflowExecution.executionId, { onDelete: "cascade" }),
    event: text().notNull(),      // node_started | node_completed | node_failed | store_write | human_task_requested | execution_terminal
    data: text().notNull(),       // JSON payload
    ts: integer({ mode: "number" }).notNull(),
  },
  (table) => [index("idx_workflow_execution_event_exec").on(table.executionId, table.seq)],
);
```

Migration `0041_workflow_execution_event.sql`（带 `--> statement-breakpoint`）+ journal idx 41。

- [ ] **Step 2: ports/adapter/service 加事件持久化**

```typescript
// ports.ts
appendExecutionEvent(input: { executionId: string; event: string; data: unknown; ts: number }): Promise<void>;
listExecutionEvents(executionId: string): Promise<Array<{ seq: number; executionId: string; event: string; data: unknown; ts: number }>>;
```

`service.ts` 的 `emit(executionId, event, data)` 内追加 `void deps.port.appendExecutionEvent({ executionId, event, data, ts: Date.now() })`（fire-and-forget，事件缓冲不阻塞 drive）。

- [ ] **Step 3: GET /api/workflow-executions/:id/trace**

```typescript
app.get("/api/workflow-executions/:executionId/trace", async ({ params }) => {
  const row = await svc.getExecution(params.executionId);
  if (!row) throw new HttpError("Execution not found", 404);
  const events = await svc.listExecutionEvents(params.executionId);
  const nodeRuns = await svc.listNodeRuns(params.executionId);
  return { execution: row, events, nodeRuns };
});
```

- [ ] **Step 4: ExecutionTraceView.tsx（时间旅行）**

```tsx
"use client";
import { useMemo, useState } from "react";
import { toEditorGraph } from "@chengchenccc/workflow";

type Ev = { seq: number; event: string; data: unknown; ts: number };
type Run = { seq: number; nodeId: string; status: string; output?: Record<string, unknown>; routedTo?: string[] };

export function ExecutionTraceView({
  execution,
  events,
  nodeRuns,
}: {
  execution: { definition: any; store: Record<string, unknown> };
  events: Ev[];
  nodeRuns: Run[];
}) {
  const [index, setIndex] = useState(events.length - 1); // 0 = start, max = 终态
  const completed = useMemo(() => {
    const done = new Set<string>();
    for (let i = 0; i <= index; i++) if (events[i]!.event === "node_completed") done.add((events[i]!.data as { nodeId: string }).nodeId);
    return done;
  }, [index, events]);
  const snapshot = useMemo(() => {
    const store: Record<string, unknown> = {};
    for (let i = 0; i <= index; i++) {
      if (events[i]!.event === "store_write") {
        const d = events[i]!.data as { key: string; value?: unknown; deleted?: boolean };
        if (d.deleted) delete store[d.key]; else store[d.key] = d.value;
      }
    }
    return store;
  }, [index, events]);

  return (
    <div className="flex h-full">
      <div className="flex-1 border-r">
        {/* 用 toEditorGraph(execution.definition) 渲染画布；completed 的节点高亮 */}
        {/* 复用 WorkflowCanvas，但根据完成集传入 node 状态 */}
      </div>
      <div className="w-80">
        <div className="p-4">
          <label className="text-xs">Time travel</label>
          <input type="range" min={0} max={events.length - 1} value={index}
            onChange={(e) => setIndex(Number(e.target.value))} className="w-full" />
          <button onClick={() => setIndex(Math.max(0, index - 1))}>◀</button>
          <button onClick={() => setIndex(Math.min(events.length - 1, index + 1))}>▶</button>
        </div>
        <div className="overflow-auto p-4 text-xs">
          <div className="mb-2 font-semibold">Event log</div>
          {events.slice(0, index + 1).map((e) => (
            <div key={e.seq} className="border-b py-1">
              <span className="text-muted-foreground">{new Date(e.ts).toLocaleTimeString()}</span>{" "}{e.event}
            </div>
          ))}
          <div className="mt-2 font-semibold">Store snapshot</div>
          <pre className="text-[10px]">{JSON.stringify(snapshot, null, 2)}</pre>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: 路由挂 trace 视图**

`GET /api/workflow-executions/:id/trace` 已在后端；web 在 `executions/page.tsx` 每行加 "trace" 链接 → `/agentic-workflow/:workflowId/executions/:executionId`（新建页面或 `ExecutionTraceView` 内嵌渲染），点击拉 trace 数据。

- [ ] **Step 6: 测试 + 全量验证**

Run: `cd apps/backend && bun test src/features/workflow`（加 trace 端点测试）+ `cd ../web && bun run typecheck && bun run lint`

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/infra/db/schema.ts apps/backend/drizzle/backend/0041_workflow_execution_event.sql apps/backend/src/features/workflow apps/web/src/components/workflow/ExecutionTraceView.tsx apps/web/src/lib/api.ts
git commit -m "feat(workflow): execution time-travel trace"
```

---

### Task 5: 全量收口 + E2E DOM 验证

**Files:**
- Create: `apps/web/tests/agentic-workflow.e2e.ts`（headless Chrome）

- [ ] **Step 1: 根仓全量**

Run: `cd /root/my-agent-team && bun run typecheck`（33/33）+ `cd apps/backend && bun test` + `cd apps/web && bun run lint`

- [ ] **Step 2: headless Chrome 全链路**

生产模式（next build + next start），登录 `/agentic-workflow`，断言：列表页渲染、点击进入详情、画布节点可见、DSL/Save 按钮存在、executions 页表格存在。

- [ ] **Step 3: Commit**

```bash
git add apps/web/tests/agentic-workflow.e2e.ts
git commit -m "test(web): e2e agentic workflow editor"
```

---

## 备注

- **git 化不做：** workflow 定义仍存 `dataDir/workflows/*.workflow.json`；git loader/commit + agent workspace git 化是后续独立 scope。
- **DSL 唯一真相源：** 交互编辑（拖拽/连边/删节点/改边条件）全部经 `onConnect`/`onNodesDelete`/`onEdgeClick` **直改 DSL state**，坐标不落 DSL；`Apply/Save` 必经 `parseWorkflow`。
- **chatAgent 真实实现：** 复用 Plan 2 `runAgentNode` 的 enqueue→dispatch→subscribe→extractOutput 路径，prompt 内嵌当前 DSL + 用户 instruction，要求返回完整 DSL JSON。
