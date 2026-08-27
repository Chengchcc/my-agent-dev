# Agentic Workflow Plan 4: 编辑器 v2 收口（视觉 + 交互 + Chat LLM）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Plan 3 编辑器从"功能骨架"升级为真正可用的 v2：Blueprint 深色视觉、React Flow 交互编辑（拖拽/连边/删节点/节点面板/边条件）、Chat 让 agent 生成 DSL patch。**不做 workflow 仓库 git 化**——git loader/commit 留到后面含 agent workspace git 化的 scope。

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

### Task 3: Chat LLM 生成 DSL patch

**Files:**
- Modify: `apps/backend/src/features/workflow/http.ts`
- Modify: `apps/backend/src/features/workflow/service.ts`
- Modify: `apps/backend/src/features/workflow/http.test.ts`
- Modify: `apps/web/src/components/workflow/ChatPanel.tsx`
- Modify: `apps/web/src/lib/api.ts`

- [ ] **Step 1: backend service 加 `chatPatch`**

`createWorkflowExecutionService` deps 加 `chatAgent?: { runPrompt(prompt: string): Promise<string> }`；`chatPatch(workflowId, definition, instruction)` 调用 `chatAgent.runPrompt`，把返回文本 `tryParseJsonObject` 得到 patch，失败抛错。返回 `{ definition }`。

- [ ] **Step 2: http.ts 加 `POST /api/workflow-definitions/:workflowId/chat-patch`**

```typescript
app.post("/api/workflow-definitions/:workflowId/chat-patch", async ({ params, body }) => {
  const raw = await Bun.file(join(dir, `${params.workflowId}.workflow.json`)).text();
  const definition = JSON.parse(raw);
  const result = await svc.chatPatch(params.workflowId, definition, body.instruction);
  return result;
}, {
  body: t.Object({ instruction: t.String({ minLength: 1 }) }),
});
```

- [ ] **Step 3: bootstrap 接 `chatAgent`**

`chatAgent: { runPrompt: async (prompt) => { /* 复用 agent-run runner：enqueue+dispatch+subscribe 取 text，像 Plan 2 runAgentNode */ } }`——真实实现复用 `agentRunService/agentRunExecution`，spike 已验证 terminal/提取路径。

- [ ] **Step 4: web api.ts + ChatPanel**

```typescript
chatPatchWorkflow: (workflowId: string, instruction: string) =>
  unwrap(client.api["workflow-definitions"]({ workflowId })["chat-patch"].post({ instruction })),
```

ChatPanel 改为：textarea 输入 instruction → `chatPatchWorkflow` → 显示返回 `{definition}` → `[Apply patch]` → `onChange(parsed)`；`[Reject]` 清空。

- [ ] **Step 5: http.test.ts 补 chat-patch 测试（fake service 返回 patch）**

- [ ] **Step 6: 全量验证**

Run: `cd apps/backend && bun test src/features/workflow && cd ../web && bun run typecheck && bun run lint`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/features/workflow apps/web/src/components/workflow/ChatPanel.tsx apps/web/src/lib/api.ts
git commit -m "feat(workflow): chat llm generates dsl patch"
```

---

### Task 4: 全量收口 + E2E DOM 验证

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
