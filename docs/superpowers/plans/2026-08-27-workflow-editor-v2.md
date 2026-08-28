# Agentic Workflow Plan 4: 编辑器 v2 收口（视觉 + 交互 + Chat LLM）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Plan 3 编辑器从"功能骨架"升级为真正可用的 v2：Blueprint 深色视觉、React Flow 交互编辑（拖拽/连边/删节点/节点面板/边条件）、Chat 让 agent 生成 DSL patch、**execution 时间旅行 trace**（可拖时间轴回放每刻画布状态/store 内容/事件日志）、**debug dry-run**（mock 输出走纯引擎，无副作用看路径/条件/结局）、**human task 表单渲染**（form schema → 可填表单，解决 HITL）。**不做 workflow 仓库 git 化**——git loader/commit 留到后面含 agent workspace git 化的 scope。

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

### Task 1: Blueprint 视觉收口（fancy）

**Files:**
- Modify: `apps/web/src/app/globals.css`
- Modify: `apps/web/src/app/(main)/layout.tsx`
- Create: `apps/web/src/components/workflow/workflow-node.tsx`
- Modify: `apps/web/src/components/workflow/WorkflowCanvas.tsx`

**设计方向（fancy）：** 一张"活体工程蓝图"——深色石墨画布 + 蓝图网格 + 噪点/辉光氛围，玻璃拟态侧栏，节点像精密仪表卡片（类型色带 + 内渐变 + 发光），运行时节点到节点的边像电路一样点亮流动。不是普通后台，是**控制台/仪表**。

### 视觉细节

- **画布底**：`#0b0e14`；每 24px `rgba(56,189,248,0.06)` 细网格 + 每 120px `rgba(56,189,248,0.12)` 粗线；叠加 `radial-gradient` 中央微辉光 + 极淡噪点纹理（data-URI）。
- **面板**：`#0f172a` + `backdrop-blur(12px)` 玻璃拟态 + 1px `rgba(148,163,184,0.12)` 描边 + 大阴影。
- **节点卡**：260×100，`#111827` 底 + 内渐变 `linear-gradient(180deg, rgba(255,255,255,0.04), transparent)`；顶部 3px 类型色带（start emerald / end rose / agent cyan / script amber / human violet）；选中= amber 外圈 `box-shadow: 0 0 0 2px var(--wf-accent), 0 0 24px rgba(245,158,11,0.35)`；hover 轻微上浮 + 提升阴影。
- **边**：基线 `#475569` + 箭头；运行中边 = amber 发光虚线流动（`stroke-dasharray: 8 6` + `@keyframes dash` + `filter: drop-shadow(0 0 6px rgba(245,158,11,0.6))`）；条件边 label 用 mono 小字胶囊。
- **字体**：Display `Bricolage Grotesque`（节点标题/页面大标）、Mono `IBM Plex Mono`（code/标签/DSL）、Body `Sora`。next/font 引入，`--font-*` 变量。
- **动效**：页面加载节点 stagger fade-in（`animation-delay`）；边 draw-in（stroke-dashoffset）；保存成功 ✓ 微动画；zoom 控件/minimap 深色化。
- **光标**：画布 `cursor: crosshair`；可点节点 `cursor: pointer` 悬停放大。
- **记忆点**：**运行时边流动**——execution 一跑，路径上的边像电路一样 amber 发光流动 + 节点点亮打勾。

- [ ] **Step 1: globals.css 加 CSS 变量 + 键帧**

```css
:root {
  --wf-canvas-bg: #0b0e14;
  --wf-panel-bg: rgba(15, 23, 42, 0.85);
  --wf-grid: rgba(56, 189, 248, 0.06);
  --wf-grid-strong: rgba(56, 189, 248, 0.12);
  --wf-node-bg: #111827;
  --wf-node-border: #1f2937;
  --wf-node-text: #e5e7eb;
  --wf-accent: #f59e0b;
  --wf-info: #38bdf8;
  --wf-color-start: #34d399;
  --wf-color-end: #fb7185;
  --wf-color-agent: #38bdf8;
  --wf-color-script: #f59e0b;
  --wf-color-human: #a78bfa;
  --font-display: var(--font-bricolage);
  --font-mono: var(--font-ibm-plex-mono);
  --font-body: var(--font-sora);
}
@keyframes wf-dash { to { stroke-dashoffset: -14; } }
@keyframes wf-pop { 0% { opacity: 0; transform: translateY(6px); } 100% { opacity: 1; transform: none; } }
```

- [ ] **Step 2: 根 app/layout.tsx 引字体（注意：`<html>` 只在根 `app/layout.tsx`，不是 `(main)/layout.tsx`）**

```tsx
import { Bricolage_Grotesque, IBM_Plex_Mono, Sora } from "next/font/google";
const bricolage = Bricolage_Grotesque({ subsets: ["latin"], variable: "--font-bricolage" });
const mono = IBM_Plex_Mono({ weight: "400", subsets: ["latin"], variable: "--font-ibm-plex-mono" });
const sora = Sora({ weight: "400", subsets: ["latin"], variable: "--font-sora" });
// <html className={`${bricolage.variable} ${mono.variable} ${sora.variable}`}>
```

- [ ] **Step 3: workflow-node.tsx（发光节点卡）**

```tsx
"use client";
import { Handle, Position, type NodeProps } from "@xyflow/react";
const typeColor: Record<string, string> = {
  start: "var(--wf-color-start)", end: "var(--wf-color-end)", agent: "var(--wf-color-agent)",
  script: "var(--wf-color-script)", human: "var(--wf-color-human)",
};
export function WorkflowNodeCard({ data, selected }: NodeProps) {
  const t = (data as { type?: string }).type ?? "script";
  return (
    <div style={{ width: 260, height: 100, borderRadius: 12, position: "relative",
      background: "linear-gradient(180deg, rgba(255,255,255,0.04), transparent), var(--wf-node-bg)",
      border: `1px solid ${selected ? "var(--wf-accent)" : "var(--wf-node-border)"}`,
      boxShadow: selected ? "0 0 0 2px var(--wf-accent), 0 0 24px rgba(245,158,11,0.35)" : "0 4px 16px rgba(0,0,0,0.4)" }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, borderRadius: "12px 12px 0 0", background: typeColor[t] ?? "var(--wf-info)", boxShadow: `0 0 8px ${typeColor[t]}` }} />
      <div style={{ padding: "16px 12px 0" }}>
        <div style={{ color: "var(--wf-node-text)", fontSize: 14, fontWeight: 600 }}>{data.label as string}</div>
        <div style={{ color: "#94a3b8", fontSize: 12, fontFamily: "var(--font-mono)" }}>{t}</div>
      </div>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
```

- [ ] **Step 4: WorkflowCanvas.tsx 接 nodeTypes + 蓝图底 + 边流动**

```tsx
import { Background, BackgroundVariant, ReactFlow, ... } from "@xyflow/react";
import { WorkflowNodeCard } from "./workflow-node";
const nodeTypes = { default: WorkflowNodeCard };
// 外层 div style={{ background: "var(--wf-canvas-bg)", cursor: "crosshair" }}
// <Background variant={BackgroundVariant.Lines} gap={24} size={1} color="var(--wf-grid)" />
// 边默认 style={stroke:#475569}；运行中边 style={{ stroke:"var(--wf-accent)", strokeDasharray:"8 6", animation:"wf-dash 1s linear infinite", filter:"drop-shadow(0 0 6px rgba(245,158,11,0.6))" }}
```

- [ ] **Step 5: typecheck + lint + commit**

Run: `cd apps/web && bun run typecheck && bun run lint`
Expected: PASS。

```bash
git add apps/web/src/app/globals.css "apps/web/src/app/(main)/layout.tsx" apps/web/src/components/workflow/workflow-node.tsx apps/web/src/components/workflow/WorkflowCanvas.tsx
git commit -m "feat(web): fancy blueprint visual system for workflow editor"
```


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
// DSL 边无 id，用 toEditorGraph 的渲染下标 "e{N}"（N = def.edges[N]）
function updateEdgeWhen(def: WorkflowDefinition, edgeIndex: number, when: unknown): WorkflowDefinition {
  return { ...def, edges: def.edges.map((e, i) => (i === edgeIndex ? { ...e, when } : e)) };
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
  edgeIndex,
  definition,
  onChange,
}: {
  edgeIndex: number;
  definition: any;
  onChange: (def: any) => void;
}) {
  const edge = definition.edges[edgeIndex];
  const [when, setWhen] = useState<string>(edge?.when ? JSON.stringify(edge.when, null, 2) : "");
  if (!edge) return null;
  return (
    <div className="space-y-3 p-4">
      <h3 className="text-sm font-semibold">Edge: {edge.from} → {edge.to}</h3>
      <label className="block text-xs">when (JSONLogic)</label>
      <textarea className="w-full rounded border p-1 font-mono" rows={6} value={when} onChange={(e) => setWhen(e.target.value)} />
      <button className="w-full rounded bg-slate-800 px-3 py-1 text-white" onClick={() => {
        try { onChange({ ...definition, edges: definition.edges.map((e: any, i: number) => i === edgeIndex ? { ...e, when: when.trim() ? JSON.parse(when) : undefined } : e) }); }
        catch { alert("Invalid JSONLogic JSON"); }
      }}>Apply</button>
    </div>
  );
}
```

- [ ] **Step 6: 侧栏接 edge 选中**

`AgenticWorkflowEditor` 增加 `activeEdgeIndex`（由 RF `onEdgeClick(e)` 的 `e.id` 解析出下标，如 `"e3"`→3）；选中边时 `tab` 切到 `attrs`，侧栏显示 `EdgePropertyPanel(edgeIndex)`。

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
- Create: `skills/agentic-workflow-dsl/registry.yaml`
- Create: `skills/agentic-workflow-dsl/reference/validate.js`（自包含 DSL 校验脚本）
- Modify: `apps/backend/src/features/workflow/http.ts`
- Modify: `apps/backend/src/features/workflow/service.ts`
- Modify: `apps/backend/src/features/workflow/http.test.ts`
- Modify: `apps/web/src/components/workflow/ChatPanel.tsx`
- Modify: `apps/web/src/lib/api.ts`

- [ ] **Step 1: 创建 `skills/agentic-workflow-dsl/SKILL.md`**

把"生成并校验 Agentic Workflow DSL 合法性"沉淀成可复用技能。SKILL.md 内容覆盖：

```markdown
---
name: agentic-workflow-dsl
description: Generate or validate an Agentic Workflow DSL (*.workflow.json). Use when asked to author/modify a workflow graph, or to check whether a given DSL is legal.
---

# Agentic Workflow DSL

## Purpose

Two jobs: **generate** a legal DSL, and **validate** a DSL's legality. A legal DSL is one that passes `parseWorkflow`.

## Shape (must be valid per parseWorkflow)

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

## Generate

Given a request, produce the entire updated DSL as a single JSON object (no markdown fence, no explanation).

## Validate — legality checklist (mirror parseWorkflow)

Run every item; a violation makes the DSL illegal:

1. `version` must be `1`.
2. Exactly one `start` node; node ids `/^[a-zA-Z0-9_-]+$/`, globally unique, non-empty.
3. `nodes` non-empty; each node `type` in start|end|agent|script|human.
4. Per-type required:
   - `end` requires non-empty `status`.
   - `agent` requires `agentId` OR (`model` AND `prompt`).
   - `script` requires non-empty `code`; optional `runtime:"bun"`.
   - `human` optional `question`/`form`.
5. `edges` reference existing node ids (both from/to).
6. Graph acyclic (Kahn topo sort must cover all nodes).
7. `when` (edge condition) is JSONLogic **subset**: `var`/`==`/`!=`/`>`/`>=`/`<`/`<=`/`in`/`and`/`or`/`not`/`if`/`!!`; `{"var":"node.output.x"}` resolves `.` paths; `nextNode` override must target an existing edge.
8. Optional per-node `inputSchema`/`outputSchema` use JSON Schema subset (`type`/`properties`/`required`/`additionalProperties`/`items`/`enum`/`minimum`/`maximum`/`minLength`/`maxLength`/`minItems`/`maxItems`).
9. Node `output` hints (if present) are `Record<string, string>` type hints.
10. Multi-true outgoing edges = parallel fan-out; branches should be mutually exclusive.

Report violations as a numbered list with the offending path ($.nodes[2].status missing). When asked to fix, return the corrected full DSL.
```
- [ ] **Step 1e: 校验脚本 `reference/validate.js`**

自包含 Bun 脚本，agent 跑 `bun reference/validate.js <*.workflow.json>` 校验 DSL：

```js
// skill: agentic-workflow-dsl/reference/validate.js
// 自包含实现 parseWorkflow 合法性规则（唯一 start、node id 合法/唯一、per-type 必填、
// 边引用存在、无环（Kahn）、when 为 JSONLogic 子集、input/output schema 关键词子集）。
// 退出码：0=合法并打印 "VALID"；1=违规，打印每条违规路径。
const file = process.argv[2];
const def = JSON.parse(require("fs").readFileSync(file, "utf8"));
const errors = [];
// ... 检查清单 ...
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
console.log("VALID", def.id);
```

规则**必须**与 `packages/workflow/src/parse.ts` 一致（两处并行维护，测试计划里加一条"validate.js 与 parseWorkflow 对同一组样例输出一致"）。

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
- Modify: `apps/web/src/components/workflow/ExecutionList.tsx`（行加 trace 链接）
- Create: `apps/web/src/app/(main)/agentic-workflow/[workflowId]/executions/[executionId]/page.tsx`（trace 详情页）
- Modify: `apps/web/src/lib/api.ts`

**分五步子步骤：**

- [ ] **Step 1: 事件持久化底座（schema/migration/ports/adapter/service）**

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
- 迁移 `0041_workflow_execution_event.sql`（breakpoint）+ journal idx 41。
- ports：`appendExecutionEvent` / `listExecutionEvents`；adapter 实现；`service.emit()` 里 `void deps.port.appendExecutionEvent(...)` 落库。
- `GET /api/workflow-executions/:id/trace` → `{ execution, events, nodeRuns }`。

- [ ] **Step 2: 时间轴组件（`ExecutionTimeline`）**

```tsx
"use client";
export function ExecutionTimeline({ index, total, onScrub }: { index: number; total: number; onScrub: (i: number) => void }) {
  return (
    <div className="flex items-center gap-2 p-3">
      <button onClick={() => onScrub(Math.max(0, index - 1))}>◀</button>
      <input type="range" min={0} max={total - 1} value={index} onChange={(e) => onScrub(Number(e.target.value))} className="flex-1" />
      <button onClick={() => onScrub(Math.min(total - 1, index + 1))}>▶</button>
      <button onClick={() => onScrub(index + 1)}>⏸/▶</button>
    </div>
  );
}
```

- [ ] **Step 3: 画布状态映射函数 `stateToGraph`**

```tsx
// 输入：execution.definition + 截至 index 的 completed set + routed edges
// 输出：Node[]（每节点带 done/pending/dim 状态） + Edge[]（每边带 lit/unlit）
function buildGraphState(def, done: Set<string>, litEdges: Set<string>, activeNode?: string) {
  const g = toEditorGraph(def);
  return {
    nodes: g.nodes.map((n) => ({ ...n, status: done.has(n.id) ? "done" : n.id === activeNode ? "active" : "idle" })),
    edges: g.edges.map((e) => ({ ...e, lit: litEdges.has(`${e.from}->${e.to}`) })),
  };
}
```

- [ ] **Step 4: store 重放器 + 事件日志**

```tsx
function replayStore(events, upto: number): Record<string, unknown> {
  const store: Record<string, unknown> = {};
  for (let i = 0; i <= upto; i++) {
    const e = events[i]!;
    if (e.event === "store_write") {
      const d = e.data as { key: string; value?: unknown; deleted?: boolean };
      if (d.deleted) delete store[d.key]; else store[d.key] = d.value;
    }
  }
  return store;
}
// 事件日志：slice(0, index+1) 渲染（ts/event/data 摘要）
```

- [ ] **Step 5: live SSE 订阅 + 边流动 + agent 子 run 跳转**

- `ExecutionTraceView` `useEffect` 用 `typedSource("/api/workflow-executions/:id/events")` 订阅；新事件 append 到 events、推进 index；画布边按 `litEdges` 加 `wf-dash` amber 流动。
- 点 agent 节点 → 若有对应 `agent_run` id，链接到 `/agent-runs/:runId`（或内嵌其事件流）。
- 每入 `execution_terminal` 停播，自动回到终态。

- [ ] **Step 6: 测试 + 全量验证 + Commit**

Run: `cd apps/backend && bun test src/features/workflow && cd ../web && bun run typecheck && bun run lint`
Expected: PASS。

```bash
git add apps/backend/src/infra/db/schema.ts apps/backend/drizzle/backend/0041_workflow_execution_event.sql apps/backend/src/features/workflow apps/web/src/components/workflow/ExecutionTraceView.tsx apps/web/src/components/workflow/ExecutionList.tsx apps/web/src/lib/api.ts
git commit -m "feat(workflow): execution time-travel trace"
```


### Task 5: Debug dry-run（mock 走纯引擎，无副作用）

**Files:**
- Create: `apps/backend/src/features/workflow/dry-run.ts`（纯逻辑）
- Modify: `apps/backend/src/features/workflow/service.ts`（+ dryRun）
- Modify: `apps/backend/src/features/workflow/http.ts`（+ POST /api/workflow-definitions/:id/dry-run）
- Modify: `apps/web/src/components/workflow/DebugPanel.tsx`（新建）
- Modify: `apps/web/src/components/workflow/AgenticWorkflowEditor.tsx`
- Modify: `apps/web/src/lib/api.ts`

- [ ] **Step 1: dry-run.ts 纯驱动**

```typescript
import { computeNext, routeOutgoing, parseWorkflow, type CompletionRecord, type WorkflowDefinition } from "@chengchenccc/workflow";

export interface DryRunStep { nodeId: string; output: Record<string, unknown>; routedTo: string[]; order: number }
export interface DryRunResult { exit: string; steps: DryRunStep[]; store: Record<string, unknown> }

export function dryRunWorkflow(
  rawDefinition: unknown,
  input: Record<string, unknown>,
  mockOutputs: Record<string, Record<string, unknown>>,
): DryRunResult {
  const def = parseWorkflow(rawDefinition);
  const store: Record<string, unknown> = {};
  const completions: CompletionRecord[] = [];
  const steps: DryRunStep[] = [];
  let order = 0;
  for (;;) {
    const step = computeNext(def, { completions, store, trigger: input });
    if (step.kind === "terminal") return { exit: step.exit, steps, store };
    if (step.kind === "idle") throw new Error("stuck: no ready nodes and no terminal");
    for (const ready of step.ready) {
      const node = ready.node;
      const output = node.type === "start" ? { ...input } : (mockOutputs[node.id] ?? {});
      const routedTo = routeOutgoing(node.id, def, completions, store, output);
      completions.push({ nodeId: node.id, output, order, routedTo });
      steps.push({ nodeId: node.id, output, routedTo, order });
      order++;
      // per-node store writes not simulated in v1; mockOutputs only
    }
  }
}
```

- [ ] **Step 2: service/http 加 dryRun 端点**

`POST /api/workflow-definitions/:workflowId/dry-run` body `{ input?: Record<unknown>, mockOutputs?: Record<string, Record<string, unknown>> }` → `dryRunWorkflow(definition, input ?? {}, mockOutputs ?? {})`。

- [ ] **Step 3: web DebugPanel**

编辑器侧栏 `attrs` Tab 下加一个 "Dry run" 区块：mockOutputs JSON 编辑器 + input JSON + `[Dry run]` → 调 `dryRunWorkflow` → 显示 `exit` + steps（节点/路由）+ 在画布高亮走到的边/节点。

- [ ] **Step 4: api.ts + 测试**

```typescript
dryRunWorkflow: (workflowId: string, body: { input?: Record<string, unknown>; mockOutputs?: Record<string, Record<string, unknown>> }) =>
  unwrap(client.api["workflow-definitions"]({ workflowId })["dry-run"].post(body)),
```

backend http.test 补 dry-run 测试（用真实 service/dry-run，或 fake）。

- [ ] **Step 5: 全量验证 + Commit**

```bash
git add apps/backend/src/features/workflow/dry-run.ts apps/backend/src/features/workflow apps/web/src/components/workflow/DebugPanel.tsx apps/web/src/lib/api.ts
git commit -m "feat(workflow): add dry-run debug capability"
```

---

### Task 6: `askQuestion` tool 能力 + 共享前端渲染器

**Files:**
- Create: `apps/oh-my-agent/src/core/tools/ask-question.ts`（oma `askQuestion` tool）
- Create: `apps/web/src/components/workflow/AskQuestionRenderer.tsx`（共享渲染器）
- Create: `apps/oh-my-agent/src/tui/ask-question.ts`（OMA TUI 专用表单渲染，非普通 tool card）
- Create: `packages/agent-contract/src/ask-question.ts`（协议类型，前后端/TUI 共用）
- Modify: `apps/backend/src/features/workflow/node-runners.ts`（human 节点走 askQuestion tool）
- Modify: `apps/backend/src/features/workflow/service.ts`（+ getPendingHuman）
- Modify: `apps/backend/src/features/workflow/http.ts`（execution detail 带 pendingHuman）
- Modify: `apps/web/src/components/workflow/AgenticWorkflowEditor.tsx`（预览）
- Modify: `apps/web/src/components/workflow/ExecutionTraceView.tsx`（resolve）

### `ask_question` 协议（定稿）

```typescript
// packages/agent-contract/src/ask-question.ts
export interface AskQuestionField {
  key: string;
  type: "string" | "textarea" | "number" | "enum" | "date" | "boolean";
  label: string;
  required?: boolean;
  options?: string[];
  placeholder?: string;
  defaultValue?: unknown;
}
export interface AskQuestionPayload {
  question_id: string;
  title: string;
  description?: string;
  fields: AskQuestionField[];
  submit_text?: string;
  skip_allowed?: boolean;
}
export interface AskQuestionAnswer {
  question_id: string;
  answers: Record<string, unknown>;
}
```

- **前端收到后**：渲染表单卡片（`AskQuestionRenderer`）。
- **提交**：回传 `{ question_id, answers }` 给 agent（tool result）。
- **对话里保留一条结构化消息**："用户已填写表单"（带 `answers`/`question_id`），供 trace/历史回放。

- [ ] **Step 1: native `askQuestion` tool（oma 内建，仿 native todo，供 agent 对话使用）**

后台/独立 CLI 里可用。native tool 弹问题、等待回答，emit `human_task_requested` 挂起，answer 返回 tool result。注册进 oma 工具表（像 `todo` 一样）。

- [ ] **Step 1b: backend 注入 `askQuestion`（product-tools MCP，仿 todo_write）**

backend 的 `product-tools` MCP server 增加 `askQuestion` 工具描述符；当 execution 流入一个 human 节点时，backend 经 MCP 注入该 tool（带 `PRODUCT_TOOLS_RUN_TOKEN` 鉴权）。child 的 agent 调用的是**注入版**，路由到 backend HITL 管道（挂起 → 等待 resolve → answer 回传）。

- [ ] **Step 1c: 冲突规则（仿 todo_write）**

`apps/oh-my-agent/src/core/runtime/tool-filter.ts` 里组装 native tool 前检查：`mounted.tools` 是否已含 `askQuestion`（backend 注入的 MCP），有则 **native 让位**（不装 native）；无则装 native。与 `todo_write` 同一套通用冲突规则。

```typescript
// apps/oh-my-agent/src/core/tools/ask-question.ts
export const askQuestionTool = {
  name: "askQuestion",
  description: "Ask the user a question and wait for an answer. Returns the submitted value.",
  inputSchema: {
    question: { type: "string" },
    // fields: Record<name, FormField>（string/textarea/number/enum/date/boolean）
    fields: { type: "object", description: "Optional structured form fields" },
  },
};
```

oma runtime 注册该 tool；调用时 emit `human_task_requested`（executionId/nodeId/question/fields）+ 挂起，`resolve_approval`/`resolve_question` 返回 answer，tool result = answer。后端把每个 "pending human" 关联到一次 `askQuestion` 调用。

- [ ] **Step 1d: OMA TUI 专用渲染（学 oh-my-pi，非普通 tool card）**

`apps/oh-my-agent/src/tui/ask-question.ts`：当 agent 调用 `ask_question` 时，TUI **不用普通 tool card**，而是渲染一个**表单卡片**：
- 标题 = `title`，描述 = `description`。
- 按 `fields` 逐字段渲染（string→input、textarea→textarea、number→number、enum→options 单选、date→date、boolean→checkbox），`required`/`placeholder`/`defaultValue` 生效。
- 底部 `submit_text`（默认 "Submit"）+ 若 `skip_allowed` 显示 "Skip"。
- 提交 → 向 agent 回传 `{ question_id, answers }`（tool result）。
- **对话保留一条结构化消息**："用户已填写表单（question_id, answers）"，markdown 渲染时显示为一块表单摘要，不塞进流式文本。
- 学 oh-my-pi 的视觉：表单卡用边框+标题+字段网格，和普通 tool card 区分。

- [ ] **Step 2: 共享前端渲染器 `AskQuestionRenderer.tsx`**

```tsx
"use client";
// 唯一 frontend 表达：question + fields（string/textarea/number/enum/date/boolean）
// 被三处复用：
//  1) workflow human 节点 resolve（ExecutionTraceView）
//  2) 编辑器 inspector 预览 human 节点 form
//  3) 普通 agent 对话中听到 askQuestion tool 调用（未来接 conversation）
export function AskQuestionRenderer({
  question,
  fields,
  values,
  onChange,
  onSubmit,
}: {
  question?: string;
  fields: Record<string, any>;
  values: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
  onSubmit?: () => void;
}) { … 按 field.type 渲染，产出 values … }
```

- [ ] **Step 3: human 节点变为"askQuestion 调用"**

**设计决策（并存，不替换）：** human 节点**保持 Plan 2 已上线的直连 `workflow_pending_human` + `resolveHumanTask`** 路径（无需每问一次都背一次 agent 子运行）；`askQuestion` 定位为 **agent 对话内的原生工具**（native + backend 注入 MCP，tool-filter 冲突让位）；两者**共享** `AskQuestionRenderer`（question + fields）作为唯一前端表达。不把 human 节点默默改成"调 askQuestion tool"——那会把传输层替换掉，代价未论证。

- [ ] **Step 4: backend 暴露 pendingHuman + api.ts**

`GET /api/workflow-executions/:id` 响应带 `pendingHuman`（含 `question/fields/status`）；service 加 `getPendingHuman(executionId, nodeId?)`。web `resolveWorkflowHumanTask` 保留。

- [ ] **Step 5: 预览 + resolve 接线**

- Inspector 选中 human 节点 → 右侧显示 `AskQuestionRenderer`（`node.form` 预览、只读/可编辑 form）。
- `ExecutionTraceView` 在 `waiting_human` 时渲染 `AskQuestionRenderer`（用 pendingHuman 的 question/fields）→ 提交 `resolveWorkflowHumanTask`。

- [ ] **Step 6: 测试 + 全量验证**

Run: `cd apps/backend && bun test src/features/workflow && cd ../web && bun run typecheck && bun run lint && cd ../oh-my-agent && bun test`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add apps/oh-my-agent/src/core/tools/ask-question.ts apps/web/src/components/workflow/AskQuestionRenderer.tsx apps/backend/src/features/workflow apps/web/src/components/workflow
git commit -m "feat(workflow): askQuestion tool capability with shared frontend renderer"
```


### Task 7: 全量收口 + E2E DOM 验证

**Files:**
- Create: `apps/web/tests/agentic-workflow.e2e.ts`（headless Chrome）

- [ ] **Step 1: 根仓全量**

Run: `bun run typecheck`（仓库根，33/33）+ `cd apps/backend && bun test` + `cd apps/web && bun run lint`

- [ ] **Step 2: headless Chrome 全链路**

生产模式（next build + next start），登录 `/agentic-workflow`，断言：列表页渲染、点击进入详情、画布节点可见、DSL/Save 按钮存在、executions 页表格存在。

- [ ] **Step 3: Commit**

```bash
git add apps/web/tests/agentic-workflow.e2e.ts
git commit -m "test(web): e2e agentic workflow editor"
```

---

## 备注

- **skill 要点：** `skills/agentic-workflow-dsl/` 需带 `registry.yaml`（比照 `skills/loop-engine/`）；description 需点明"生成/校验 Agentic Workflow DSL（*.workflow.json）"，与既有 `skills/workflow-authoring`（oma 子代理 fan-out/workflow_run 编排，另一码事）区分。
- **emit 落库容错：** `void deps.port.appendExecutionEvent(...)` 需要 `.catch(() => {})`（事件持久化失败不阻塞 drive）。
- **git 化不做：** workflow 定义仍存 `dataDir/workflows/*.workflow.json`；git loader/commit + agent workspace git 化是后续独立 scope。
- **DSL 唯一真相源：** 交互编辑（拖拽/连边/删节点/改边条件）全部经 `onConnect`/`onNodesDelete`/`onEdgeClick` **直改 DSL state**，坐标不落 DSL；`Apply/Save` 必经 `parseWorkflow`。
- **chatAgent 真实实现：** 复用 Plan 2 `runAgentNode` 的 enqueue→dispatch→subscribe→extractOutput 路径，prompt 内嵌当前 DSL + 用户 instruction，要求返回完整 DSL JSON。

---

## 测试计划（Plan 4 收尾验收清单）

### 单元层（`@chengchenccc/workflow`，快，~29 tests）

- `parseWorkflow`：合法/非法（未知节点、重复 id、缺 start、环、agent 二选一、script code 必填、meta 透传、`when:null`→unconditional）
- `json-logic`：子集算子、var 路径/default、裸对象 not/!!、比较、in、if
- `graph`：topoSort、routeOutgoing（无条件/条件/nextNode 覆盖/fail-fast）、mergeInputs（全局合并+provenance+nextNode 过滤）
- `engine.computeNext`：首步 start、branch 路由、AND-join 等待、terminal 多出口、idle、input 默认值
- `schema.validateBySchema`：object/array/string/enum/边界（required/additionalProperties/items/min-max/minItems）
- `editor`：layeredLayout 分层、toEditorGraph 节点/边映射

### 后端集成层（features/workflow）

- adapter-sqlite：execution/node_run/pendingHuman/listExecutions CRUD
- service 循环：线性成功、input schema 违反→failure、human 挂起→resolve→success、agent 节点 JSON output、**fan-out AND-join 服务级、retry→failure、recover(重启重建 completions)、node_failed 事件**
- http：POST execution、GET 单条/list、def CRUD、human-task resolve、**dry-run、chat-patch、trace 端点**
- 真实 agent node（1 条慢集成，rpc-fixture）：enqueue→dispatch→subscribe→JSON output

### 前端层

- typecheck/lint 必绿
- 组件：WorkflowCanvas（RF 节点/边）、AskQuestionRenderer（各 field type）、DslEditorPanel（Apply 过 parseWorkflow）
- E2E（headless Chrome，生产模式 next build+start）：
  - 列表页渲染→进详情
  - 画布节点可见、点节点出属性面板
  - DSL Apply/Save 往返（PUT def → GET 回读一致）
  - executions 列表 + trace 时间轴拖动（画布状态随 index 变）
  - dry-run 无副作用（mock 走完、画布高亮）
  - human task 表单渲染 + resolve
  - live SSE：跑一个 execution，边/节点实时点亮

### 门禁（每次改动必过）

```bash
bun run typecheck          # root 33/33
cd apps/backend && bun test   # 全量
cd apps/web && bun run lint
# 迁移：openDb(":memory:") 套 0040/0041，PRAGMA table_info 核对三表
```

### 风险/未覆盖

- dry-run 无副作用：断言调用后 `workflow_execution` / `agent_run` 无新增行（dry-run 不写库）。
- trace 事件持久化：`workflow_execution_event` 行数 = 事件数，store 重放终态 = 库里 `execution.store`。
- recover 崩溃窗口：running 但节点未完成时 recover 不重复 append（防重复 guard 需测试）。
- chat-patch（skill）单测用 mock；真 agent 产 DSL 留 1 条慢 E2E。
- human timeout（spec 决策 #4）未实现，测试不期望它。
