# Agentic Workflow Plan 3: web `/agentic-workflow` 编辑器 v1

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 web 落地 `/agentic-workflow` 编辑器 v1——只读画布渲染 workflow DSL + 节点属性面板 + DSL 编辑/保存面板（chat 形式改 DSL 留 v2）。

**Architecture:** 复用 `@chengchenccc/workflow` 的 `toEditorGraph` + `layeredLayout` 做画布（纯 SVG，无新依赖）。新增 backend workflow-definition 读写端点（file-first：`dataDir/workflows/*.workflow.json`）。页面 = server 组件 SSR 加载定义 → `use client` 编辑器组件（canvas/属性/dsl 编辑器）。v1 的 chat 侧栏 = Monaco DSL 编辑 + Apply + Save；"让 agent 生成补丁"作为 v2 占位按钮。

**Tech Stack:** Next.js 15 App Router, React 19, React Query v5, shadcn/ui, `@monaco-editor/react`（已是 web dep）, `@chengchenccc/workflow`（新增 web 依赖）, Elysia backend, bun:test。

Spec: `docs/superpowers/specs/2026-08-27-agentic-workflow-design.md`

## UX 与视觉方向（设计契约，实现必须遵守）

**概念：Blueprint / Control Surface。** Workflow 是工程制品，编辑器像一张"活体蓝图"——深色控制台上一张可缩放/平移的逻辑图纸，运行时节点/边发光流动。不是通用后台仪表盘，是"流程图工作台"。

### UX 流程（三层 IA：列表 → 详情 → execution）

路由：
- `/agentic-workflow` → **workflow 列表页**（管理元数据）
- `/agentic-workflow/:workflowId` → **编辑详情页**（画布 + 侧栏 属性/DSL/Chat）
- `/agentic-workflow/:workflowId/executions` → **execution 列表页**（运行记录 + Run）

**列表页**：卡片/表展示 `meta`（name、description、tags、status 徽章、workflowId、owner/updatedBy），动作：打开（进详情）、删除、复制、`+ New`。空态 CTA 创建。

**详情页**：
- 顶栏：返回列表 + 当前 name/id + dirty/unsaved + `⌘S Save` + 链接 `→ executions`。
- 左画布（flex-1）Blueprint 网格 + RF。
- 右侧栏 360px，3 Tab：`属性`（节点/边 inspector）、`DSL`（Monaco JSON + Apply/Save）、`Chat`（v2 占位：自然语言 → agent 生成 DSL patch → Apply patch）。
- 状态：loading/empty/dirty/saving/saved/error。
- 键盘：`Cmd/Ctrl+S` 保存，`Esc` 取消选中，方向键跳节点。
- 无障碍：画布节点 focusable button，inspector 字段带 `<label>`。

**execution 列表页**：
- 顶栏：返回详情 + `+ Run`（input JSON 弹窗 → POST → 刷新）。
- 表格：executionId、status 徽章（running/success/failure/custom）、exit、createdAt；点击行为查看事件流（SSE timeline）。
- 空态：无 execution。

### ASCII 版式（三层 IA）

```text
/agentic-workflow                        /agentic-workflow/:id                    /agentic-workflow/:id/executions
┌────────────────────────────┐        ┌──────────────────────────────────────┐  ┌────────────────────────────────────┐
│ ● Agentic Workflow 列表     │        │ ← 列表   oncall-triage  ● unsaved ⌘S  │  │ ← 详情   oncall-triage  [+ Run]    │
│ + New                       │        │                                      │  │────────────────────────────────────│
│ ┌────────────────────────┐  │        │ ┌─ CANVAS ────────────┐ ┌─ Sidebar ─┐│  │ executionId  status    exit  time │
│ │ oncall-triage           │  │        │ │ ┌────┐ ┌─────┐ ┌────┐│ │[属性][DSL]││  │ 01HSY… running ●  -      12:01  │
│ │  分诊 · tags[oncall]     │  │        │ │ START│─│agent│─│HUM ││ │[Chat]     ││  │ 01HSZ… success ✓  ok    11:50  │
│ │  status: draft  owner:me │  │        │ │ └────┘ │cyan │ └────┘│ │ ┌───────┐ ││  │ 01HTA… failure ✗  ×     11:20  │
│ └────────────────────────┘  │        │ │  └─┘   └─────┘        │ │ │ DSL   │ ││  │  ▸ 查看事件流               │
│ │ alert-notify  ...         │        │ │   运行中边 amber 流动    │ │ │ JSON  │ ││  │                            │
│ └────────────────────────┘  │        │ └────────────────────────┘ └─└───────┘ ││  └────────────────────────────┘│
└────────────────────────────┘        └──────────────────────────────────────┘  └────────────────────────────┘
```

### 视觉方向

- **主题**：深色控制台，非通用浅色 SaaS。/ 画布背景 `#0B0E14`；侧栏 `#0F172A`；输入 `#1E293B`。
- **画布底纹**：Blueprint 网格——每 24px `rgba(56,189,248,0.07)` 细线，每 120px `rgba(56,189,248,0.14)` 粗线；叠加极淡 `#0B0E14` 噪点纹理。
- **节点**：近黑卡片 `#111827` 填充 + `#1F2937` 边框 + `#E5E7EB` 文本；**顶部 3px 类型色带**：start=`#34D399`(emerald)、end=`#FB7185`(rose)、agent=`#38BDF8`(cyan)、script=`#F59E0B`(amber)、human=`#A78BFA`(violet)。选中＝amber 外圈 glow。
- **边**：默认 `#475569` 1.5px 实线 + 箭头；带条件边用 mono 小字标 `when`；**运行中边 = `#F59E0B` 动画虚线流动**（`stroke-dasharray` + keyframes）。
- **强调色**：`#F59E0B`（active/选中/保存）、`#38BDF8`（信息/进行中）。
- **字体**（next/font，`layout.tsx` 引入）：Display = `Bricolage Grotesque`（几何、有性格）；代码/标签/DSL = `IBM Plex Mono`；正文 = `Sora`。避免 Inter/system。
- **动效（gated，CSS-only + RF）**：页面加载时边 `stroke-dashoffset` 画入 + 节点 stagger fade-in；hover 节点 `translateY(-2px)` + 阴影；运行中边 pulse；save 成功 ✓ 形态。
- **空间**：非对称——画布 ~65%，侧栏固定 360；RF minimap 右下、zoom 控件左下；节点卡片 260×100（扁平圆角 12）。
- **记忆点**：**运行时的边流动**——execution 一跑，路径上的边像电路一样亮起 amber 虚线，结束节点打勾。这是这款编辑器最让人记住的产品时刻。

### 实现复杂度匹配

中等：RF + CSS keyframes + next/font + shadcn 重样式；不做 3D/大规模动效。所有颜色/字体/网格以 CSS 变量集中定义，方便整体换肤。

---

## 文件结构

```
apps/backend/src/features/workflow/http.ts        # + /api/workflow-definitions list/get/put/delete + /api/workflow-executions list
apps/backend/src/features/workflow/http.test.ts   # + def/exec endpoints tests
apps/backend/src/bootstrap/features.ts            # workflowRoutes 传 workflowDir

apps/web/package.json                             # + @chengchenccc/workflow + @xyflow/react
apps/web/src/lib/api.ts                           # + workflow definition/execution methods + types
apps/web/src/app/(main)/agentic-workflow/page.tsx # 列表页（server SSR）
apps/web/src/app/(main)/agentic-workflow/[workflowId]/page.tsx            # 编辑详情页（server SSR）
apps/web/src/app/(main)/agentic-workflow/[workflowId]/executions/page.tsx # execution 列表页（server SSR）
apps/web/src/components/workflow/WorkflowList.tsx        # 列表 client
apps/web/src/components/workflow/AgenticWorkflowEditor.tsx # 详情 client（画布+侧栏）
apps/web/src/components/workflow/WorkflowCanvas.tsx       # 只读 RF 画布
apps/web/src/components/workflow/NodePropertyPanel.tsx    # 节点/边属性
apps/web/src/components/workflow/DslEditorPanel.tsx       # Monaco DSL + Apply/Save
apps/web/src/components/workflow/ChatPanel.tsx            # v2 占位
apps/web/src/components/workflow/ExecutionList.tsx        # execution 列表 client
apps/web/src/components/NavRail.tsx               # + SidebarMenuItem
```


---

### Task A: backend workflow-definition 读写端点

**Files:**
- Modify: `apps/backend/src/features/workflow/http.ts`
- Modify: `apps/backend/src/features/workflow/http.test.ts`
- Modify: `apps/backend/src/bootstrap/features.ts`

- [ ] **Step 1: http.ts 增加 deps.workflowDir + 三个路由**

```typescript
import { join } from "node:path";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";

export function workflowRoutes(deps: {
  workflowExecutionService: WorkflowExecutionService;
  loadWorkflow: (ref: WorkflowRef) => Promise<string>;
  workflowDir: string;
}) {
  const svc = deps.workflowExecutionService;
  const app = new Elysia();
  // ... 现有 POST/GET/events/human-task 路由 ...

  app.get("/api/workflow-definitions", async () => {
    mkdirSync(deps.workflowDir, { recursive: true });
    const files = readdirSync(deps.workflowDir).filter((f) => f.endsWith(".workflow.json"));
    return {
      definitions: files.map((f) => ({
        workflowId: f.replace(/\.workflow\.json$/, ""),
        path: f,
      })),
    };
  });
  app.get("/api/workflow-definitions/:workflowId", async ({ params }) => {
    const file = join(deps.workflowDir, `${params.workflowId}.workflow.json`);
    const text = await Bun.file(file).text();
    return { definition: JSON.parse(text) };
  });
  app.put(
    "/api/workflow-definitions/:workflowId",
    async ({ params, body }) => {
      mkdirSync(deps.workflowDir, { recursive: true });
      const file = join(deps.workflowDir, `${params.workflowId}.workflow.json`);
      writeFileSync(file, JSON.stringify(body.definition, null, 2));
      return { ok: true, definition: body.definition };
    },
    {
      body: t.Object({
        definition: t.Record(t.String(), t.Unknown()),
      }),
    },
  );
  return app;
}
```

> 文件名从 `*path*` 直接当 id；`Bun.file(file).text()` 若文件不存在会抛，需在 http.test 里先 PUT 再 GET。

- [ ] **Step 2: bootstrap 传 workflowDir**

`workflowRoutes({ workflowExecutionService, loadWorkflow, workflowDir: join(config.dataDir, "workflows") })`——`workflowRoutes` 的现有调用点加第三个参数。

- [ ] **Step 3: http.test.ts 补 def 端点测试**

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("workflow definition list/get/put roundtrip", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-def-"));
  const app = workflowRoutes({ workflowExecutionService: fakeService, loadWorkflow: async () => JSON.stringify(def), workflowDir: dir });
  // PUT then GET
  await app.handle(new Request("http://localhost/api/workflow-definitions/wf", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ definition: def }) }));
  const get = await app.handle(new Request("http://localhost/api/workflow-definitions/wf"));
  expect((await get.json()) as { definition: { id: string } }).definition.id).toBe("wf");
  const list = await app.handle(new Request("http://localhost/api/workflow-definitions"));
  expect((await list.json()) as { definitions: Array<{ workflowId: string }> }).definitions[0]!.workflowId).toBe("wf");
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/backend && bun test src/features/workflow/http.test.ts`
Expected: PASS（原 3 测试 + 新 1）。

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/features/workflow/http.ts apps/backend/src/features/workflow/http.test.ts apps/backend/src/bootstrap/features.ts
git commit -m "feat(workflow): add workflow definition read/write endpoints"
```

---

### Task A2: execution 列表 + 删除 workflow 定义

**Files:**
- Modify: `apps/backend/src/features/workflow/ports.ts`
- Modify: `apps/backend/src/features/workflow/adapter-sqlite.ts`
- Modify: `apps/backend/src/features/workflow/service.ts`
- Modify: `apps/backend/src/features/workflow/http.ts`

- [ ] **Step 1: ports.ts 加 `listExecutions`**

```typescript
listExecutions(workflowId?: string): Promise<WorkflowExecutionRow[]>;
```

- [ ] **Step 2: adapter-sqlite.ts 实现**

```typescript
import { desc } from "drizzle-orm"; // 加到顶部 import
// return 对象内：
async listExecutions(workflowId?: string) {
  const rows = workflowId
    ? await d.select().from(workflowExecution).where(eq(workflowExecution.workflowId, workflowId)).orderBy(desc(workflowExecution.createdAt))
    : await d.select().from(workflowExecution).orderBy(desc(workflowExecution.createdAt));
  return rows.map(toExec);
},
```

- [ ] **Step 3: service.ts 加 `listExecutions`**

```typescript
// interface 加：
listExecutions(workflowId?: string): Promise<WorkflowExecutionRow[]>;
// return 对象加：
async listExecutions(workflowId) { return deps.port.listExecutions(workflowId); },
```

- [ ] **Step 4: http.ts 加两条路由 + 删除定义**

```typescript
app.get("/api/workflow-executions", async ({ query }) => {
  return await svc.listExecutions(query.workflowId);
}, { query: t.Object({ workflowId: t.Optional(t.String()) }) });

app.delete("/api/workflow-definitions/:workflowId", async ({ params }) => {
  const file = join(deps.workflowDir, `${params.workflowId}.workflow.json`);
  rmSync(file, { force: true });
  return { ok: true };
});
```

顶部 `import { rmSync } from "node:fs"`。

- [ ] **Step 5: 补 http.test（执行列表 + 删除）**

```typescript
test("list executions and delete definition", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-exec-"));
  const app = workflowRoutes({ workflowExecutionService: fakeService, loadWorkflow: async () => JSON.stringify(def), workflowDir: dir });
  await app.handle(new Request("http://localhost/api/workflow-definitions/wf", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ definition: def }) }));
  const list = await app.handle(new Request("http://localhost/api/workflow-executions"));
  expect((await list.json()) as { executions?: unknown }).executions).toBeDefined();
  const del = await app.handle(new Request("http://localhost/api/workflow-definitions/wf", { method: "DELETE" }));
  expect(del.status).toBe(200);
  rmSync(dir, { recursive: true, force: true });
});
```

fakeService 需加 `listExecutions: async () => []`。

- [ ] **Step 6: 跑测试确认通过**

Run: `cd apps/backend && bun test src/features/workflow/http.test.ts`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/features/workflow
git commit -m "feat(workflow): add workflow execution list and delete definition"
```

---

### Task B: web 依赖 + api.ts workflow 调用

**Files:**
- Modify: `apps/web/package.json`
- Modify: `apps/web/src/lib/api.ts`

- [ ] **Step 1: 加 web 依赖**

`apps/web/package.json` dependencies 加：
- `"@chengchenccc/workflow": "workspace:*"`
- `"@xyflow/react": "^12.0.0"`

根跑 `bun install`。

- [ ] **Step 2: api.ts 加 workflow methods**

```typescript
export type WorkflowDefinitionRow = ApiReturn<typeof api.listWorkflowDefinitions>["definitions"][number];

export const api = {
  // ... 现有 ...
  listWorkflowDefinitions: () => unwrap(client.api.workflowDefinitions.get()),
  getWorkflowDefinition: (workflowId: string) =>
    unwrap(client.api.workflowDefinitions({ workflowId }).get()),
  saveWorkflowDefinition: (workflowId: string, definition: unknown) =>
    unwrap(
      client.api.workflowDefinitions({ workflowId }).put({ definition }),
    ),
  deleteWorkflowDefinition: (workflowId: string) =>
    unwrap(client.api.workflowDefinitions({ workflowId }).delete()),
  listWorkflowExecutions: (workflowId?: string) =>
    unwrap(client.api.workflowExecutions.get({ query: workflowId ? { workflowId } : undefined })),
  startWorkflowExecution: (body: { workflowRef: { repo: string; path: string }; input?: Record<string, unknown> }) =>
    unwrap(client.api.workflowExecutions.post(body)),
};
```

> Eden 路径由 backend App 类型自动生成（`/api/workflow-definitions` → `client.api.workflowDefinitions`）。`client` 走 BFF `/api/bff`。

- [ ] **Step 3: typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add apps/web/package.json apps/web/src/lib/api.ts bun.lock
git commit -m "feat(web): add workflow definition api client"
```

---

### Task C: web 编辑器页面 + 只读画布

**Files:**
- Create: `apps/web/src/app/(main)/agentic-workflow/page.tsx`
- Create: `apps/web/src/components/AgenticWorkflowEditor.tsx`
- Create: `apps/web/src/components/workflow/WorkflowCanvas.tsx`

- [ ] **Step 1: page.tsx（server SSR）**

```tsx
import { parseEnv } from "@chengchenccc/config";
import { AgenticWorkflowEditor } from "@/components/AgenticWorkflowEditor";
import { createServerClient, unwrap } from "@/lib/client";

export default async function AgenticWorkflowPage() {
  const env = parseEnv(process.env);
  const client = createServerClient(env.BACKEND_URL, env.BACKEND_AUTH_TOKEN);
  const list = await unwrap(client.api.workflowDefinitions.get()).catch(() => ({
    definitions: [] as Array<{ workflowId: string; path: string }>,
  }));
  const first = list.definitions[0];
  const definition = first
    ? await unwrap(client.api.workflowDefinitions({ workflowId: first.workflowId }).get())
        .then((r) => r.definition as unknown)
        .catch(() => null)
    : null;
  return <AgenticWorkflowEditor definitions={list.definitions} initial={definition} />;
}
```

- [ ] **Step 2: AgenticWorkflowEditor.tsx（client）**

```tsx
"use client";
import { useMemo, useState } from "react";
import { toEditorGraph } from "@chengchenccc/workflow";
import { WorkflowCanvas } from "./workflow/WorkflowCanvas";
import { NodePropertyPanel } from "./workflow/NodePropertyPanel";
import { DslEditorPanel } from "./workflow/DslEditorPanel";

export function AgenticWorkflowEditor({
  definitions,
  initial,
}: {
  definitions: Array<{ workflowId: string; path: string }>;
  initial: unknown;
}) {
  const [definition, setDefinition] = useState<unknown>(initial);
  const [activeId, setActiveId] = useState<string | null>(null);
  const graph = useMemo(
    () => (definition ? toEditorGraph(definition as { version: 1; id: string; nodes: any[]; edges: any[] }) : null),
    [definition],
  );
  return (
    <div className="flex h-full">
      <div className="flex-1 border-r">
        {graph ? (
          <WorkflowCanvas graph={graph} onSelect={(id) => setActiveId(id)} />
        ) : (
          <div className="p-8 text-muted-foreground">No workflow loaded.</div>
        )}
      </div>
      <div className="w-80">
        {activeId && definition ? (
          <NodePropertyPanel nodeId={activeId} definition={definition} onChange={setDefinition} />
        ) : (
          <DslEditorPanel definition={definition} onChange={setDefinition} initialDefinitions={definitions} />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: WorkflowCanvas.tsx（React Flow）**

```tsx
"use client";
import { useMemo } from "react";
import { ReactFlow, Background, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { EditorGraph } from "@chengchenccc/workflow";

export function WorkflowCanvas({
  graph,
  onSelect,
}: {
  graph: EditorGraph;
  onSelect: (id: string) => void;
}) {
  const nodes: Node[] = useMemo(
    () =>
      graph.nodes.map((n) => ({
        id: n.id,
        position: { x: n.x, y: n.y },
        data: { label: n.label, type: n.type, layer: n.layer },
      })),
    [graph],
  );
  const edges: Edge[] = useMemo(
    () =>
      graph.edges.map((e) => ({
        id: e.id,
        source: e.from,
        target: e.to,
        label: e.label,
      })),
    [graph],
  );
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={true}
      fitView
      onNodeClick={(_, node) => onSelect(node.id)}
    >
      <Background />
    </ReactFlow>
  );
}
```

- [ ] **Step 4: typecheck + run dev/build**

Run: `cd apps/web && bun run typecheck`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/"(main)"/agentic-workflow/page.tsx apps/web/src/components/AgenticWorkflowEditor.tsx apps/web/src/components/workflow/WorkflowCanvas.tsx
git commit -m "feat(web): add agentic workflow editor canvas page"
```

---

### Task D: 节点属性面板

**Files:**
- Create: `apps/web/src/components/workflow/NodePropertyPanel.tsx`

- [ ] **Step 1: 创建 NodePropertyPanel.tsx**

```tsx
"use client";
import { useMemo, useState } from "react";

function updateNode(definition: any, nodeId: string, patch: Record<string, unknown>): any {
  return {
    ...definition,
    nodes: definition.nodes.map((n: any) => (n.id === nodeId ? { ...n, ...patch } : n)),
  };
}

export function NodePropertyPanel({
  nodeId,
  definition,
  onChange,
}: {
  nodeId: string;
  definition: any;
  onChange: (def: any) => void;
}) {
  const node = useMemo(() => definition.nodes.find((n: any) => n.id === nodeId), [definition, nodeId]);
  if (!node) return null;
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  return (
    <div className="space-y-3 p-4">
      <h3 className="text-sm font-semibold">Node: {nodeId}</h3>
      <label className="block text-xs">type</label>
      <input value={node.type} className="w-full rounded border p-1" readOnly />
      {node.type === "agent" && (
        <>
          <label className="block text-xs">agentId</label>
          <input
            value={node.agentId ?? ""}
            className="w-full rounded border p-1"
            onChange={(e) => setDraft({ ...draft, agentId: e.target.value })}
          />
          <label className="block text-xs">prompt</label>
          <textarea
            value={node.prompt ?? ""}
            className="w-full rounded border p-1"
            rows={4}
            onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
          />
        </>
      )}
      {node.type === "script" && (
        <>
          <label className="block text-xs">code</label>
          <textarea
            value={node.code ?? ""}
            className="w-full rounded border p-1 font-mono"
            rows={8}
            onChange={(e) => setDraft({ ...draft, code: e.target.value })}
          />
        </>
      )}
      {node.type === "end" && (
        <label className="block text-xs">status</label>
      )}
      {node.type === "end" && (
        <input
          value={node.status ?? ""}
          className="w-full rounded border p-1"
          onChange={(e) => setDraft({ ...draft, status: e.target.value })}
        />
      )}
      <button
        className="w-full rounded bg-slate-800 px-3 py-1 text-white"
        onClick={() => onChange(updateNode(definition, nodeId, draft))}
      >
        Apply
      </button>
    </div>
  );
}
```

- [ ] **Step 2: typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/workflow/NodePropertyPanel.tsx
git commit -m "feat(web): add agentic workflow node property panel"
```

---

### Task E: DSL 编辑/保存面板

**Files:**
- Create: `apps/web/src/components/workflow/DslEditorPanel.tsx`

- [ ] **Step 1: 创建 DslEditorPanel.tsx**

```tsx
"use client";
import { useState } from "react";
import Editor from "@monaco-editor/react";
import { api } from "@/lib/api";

export function DslEditorPanel({
  definition,
  onChange,
  initialDefinitions,
}: {
  definition: unknown;
  onChange: (def: unknown) => void;
  initialDefinitions: Array<{ workflowId: string; path: string }>;
}) {
  const [text, setText] = useState<string>(definition ? JSON.stringify(definition, null, 2) : "");
  const [message, setMessage] = useState<string | null>(null);
  const selected = initialDefinitions[0]?.workflowId ?? "wf";

  function apply() {
    try {
      const parsed = JSON.parse(text);
      onChange(parsed);
      setMessage("Applied to canvas.");
    } catch (err) {
      setMessage(`Invalid JSON: ${(err as Error).message}`);
    }
  }

  async function save() {
    try {
      const parsed = JSON.parse(text);
      await api.saveWorkflowDefinition(selected, parsed);
      setMessage("Saved.");
    } catch (err) {
      setMessage(`Save failed: ${(err as Error).message}`);
    }
  }

  return (
    <div className="flex h-full flex-col p-4">
      <div className="mb-2 text-sm font-semibold">Workflow DSL</div>
      <Editor
        height="60vh"
        defaultLanguage="json"
        value={text}
        onChange={(v) => setText(v ?? "")}
        options={{ minimap: { enabled: false }, fontSize: 12 }}
      />
      <div className="mt-2 flex gap-2">
        <button className="rounded bg-slate-800 px-3 py-1 text-white" onClick={apply}>
          Apply
        </button>
        <button className="rounded border px-3 py-1" onClick={save}>
          Save
        </button>
      </div>
      {message && <div className="mt-2 text-xs text-muted-foreground">{message}</div>}
      <div className="mt-4 border-t pt-2 text-xs text-muted-foreground">
        v2: chat 让 agent 生成 DSL 补丁（占位）
      </div>
    </div>
  );
}
```

- [ ] **Step 2: typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/workflow/DslEditorPanel.tsx
git commit -m "feat(web): add dsl editor and save panel"
```

---

### Task F: 导航接线 + 全量验证

**Files:**
- Modify: `apps/web/src/components/NavRail.tsx`

- [ ] **Step 1: 加 SidebarMenuItem**

```tsx
<SidebarMenuItem
  label="Agentic Workflow"
  isActive={pathname === "/agentic-workflow"}
  onClick={() => router.push("/agentic-workflow")}
/>
```

（按 NavRail 现有 `SidebarMenuItem` 用法插入到对应 SidebarGroup。）

- [ ] **Step 2: 全量验证**

Run: `cd apps/web && bun run typecheck`
Expected: PASS。

Run: `cd apps/web && bun run lint`
Expected: PASS。

Run: `cd /root/my-agent-team && bun run typecheck`
Expected: PASS（root 全仓）。

Run: `cd apps/backend && bun test src/features/workflow`
Expected: PASS（含新增 def 端点测试）。

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/NavRail.tsx
git commit -m "feat(web): add agentic workflow nav entry"
```

---

## 备注

- **file-first：** `dataDir/workflows/*.workflow.json` 是 v1 本地存储，非 git 仓库；真实 git loader/commit 在后续 plan（换 `loadWorkflow`/`saveWorkflowDefinition` 实现，web 层不变）。
- **chat 改 DSL（v2）：** 右侧 DSL 面板是 Monaco JSON 编辑；"让 agent 生成补丁"占位。后续接现有 conversation chat（reuse `useConversation`/SSE/send message）让 agent 产出 DSL patch 后回填。
- **画布：** v1 用 `@xyflow/react` 渲染，消费 `toEditorGraph`/`layeredLayout`；`nodesDraggable=false` 只读，v2 开启拖拽连线。
- **测试：** 该 plan 以 typecheck/lint + backend http test 为主；真 DOM 渲染验证（headless Chrome）留到最终联调。

## v2 编辑能力支撑（架构约定，本 plan 起不返工）

React Flow 只是**派生视图**，**DSL 永远唯一真相源**。v2 完整编辑的分工：

1. **不要用有损反向适配器**：`toEditorGraph` 产出的 `EditorGraph` 只是视图（丢了节点完整 config），**不能用来回写 DSL**。v2 编辑走"RF 事件直接改 DSL"：
   - `onNodeDragStop` → 忽略（位置由 `layeredLayout` 重算，不写 DSL）
   - `onConnect` → 往 `def.edges` 追加 `{from, to, when: undefined}`（id 由 editor 生成，`NODE_ID_RE` 校验）
   - `onNodesDelete` → 从 `def.nodes`/`def.edges` 联动删除
   - 节点创建面板 → 插入该类型默认 config 到 `def.nodes`
   - 点边 → 属性面板编辑该 DSL edge 的 `when`（JSONLogic JSON），不靠 RF label
2. **保存前必过 `parseWorkflow`**：必填（`script.code`/`end.status`/`agent` 二选一）、非法 id、环检测都在 `Apply/Save` 拦截，不合格不落盘。
3. **`EditorEdge` 保留 `when` 只是辅助展示**（v1 就把 `e.when` 放进 `EditorEdge.when`），不作为回写依据。

这样 v2 只需在 web 侧加 RF 事件处理 + 节点类型面板 + 边属性面板，`@chengchenccc/workflow` 的 `toEditorGraph`/`layeredLayout` 保持不变。
