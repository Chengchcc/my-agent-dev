# Agentic Workflow Plan 3: web `/agentic-workflow` 编辑器 v1

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 web 落地 `/agentic-workflow` 编辑器 v1——只读画布渲染 workflow DSL + 节点属性面板 + DSL 编辑/保存面板（chat 形式改 DSL 留 v2）。

**Architecture:** 复用 `@chengchenccc/workflow` 的 `toEditorGraph` + `layeredLayout` 做画布（纯 SVG，无新依赖）。新增 backend workflow-definition 读写端点（file-first：`dataDir/workflows/*.workflow.json`）。页面 = server 组件 SSR 加载定义 → `use client` 编辑器组件（canvas/属性/dsl 编辑器）。v1 的 chat 侧栏 = Monaco DSL 编辑 + Apply + Save；"让 agent 生成补丁"作为 v2 占位按钮。

**Tech Stack:** Next.js 15 App Router, React 19, React Query v5, shadcn/ui, `@monaco-editor/react`（已是 web dep）, `@chengchenccc/workflow`（新增 web 依赖）, Elysia backend, bun:test。

Spec: `docs/superpowers/specs/2026-08-27-agentic-workflow-design.md`

**范围外（后续 plan）：** 拖拽连线画布（v2）、LLM chat 生成 DSL 补丁（v2）、真实 git 仓库 loader/提交（本 plan 用 `dataDir/workflows` 本地文件读写，注释注明后续换 git）、CronJob workflow target、loop 删除。

---

## 文件结构

```
apps/backend/src/features/workflow/http.ts        # + /api/workflow-definitions list/get/put + deps.workflowDir
apps/backend/src/features/workflow/http.test.ts   # + def endpoints tests
apps/backend/src/bootstrap/features.ts            # workflowRoutes 传 workflowDir

apps/web/package.json                             # + @chengchenccc/workflow
apps/web/src/lib/api.ts                           # + listWorkflowDefinitions/getWorkflowDefinition/saveWorkflowDefinition + types
apps/web/src/app/(main)/agentic-workflow/page.tsx # server 组件（SSR 加载定义）
apps/web/src/components/AgenticWorkflowEditor.tsx # 'use client'：状态 + 三面板布局
apps/web/src/components/workflow/WorkflowCanvas.tsx  # 只读 SVG 画布（toEditorGraph）
apps/web/src/components/workflow/NodePropertyPanel.tsx # 属性面板
apps/web/src/components/workflow/DslEditorPanel.tsx    # Monaco DSL 编辑 + Apply/Save
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

### Task B: web 依赖 + api.ts workflow 调用

**Files:**
- Modify: `apps/web/package.json`
- Modify: `apps/web/src/lib/api.ts`

- [ ] **Step 1: 加 web 依赖**

`apps/web/package.json` dependencies 加 `"@chengchenccc/workflow": "workspace:*"`，根跑 `bun install`。

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

- [ ] **Step 3: WorkflowCanvas.tsx（只读 SVG）**

```tsx
"use client";
import type { EditorGraph } from "@chengchenccc/workflow";

export function WorkflowCanvas({
  graph,
  onSelect,
}: {
  graph: EditorGraph;
  onSelect: (id: string) => void;
}) {
  const width = Math.max(...graph.nodes.map((n) => n.x)) + 260;
  const height = Math.max(...graph.nodes.map((n) => n.y + 100));
  return (
    <svg width={width} height={height} className="block">
      {graph.edges.map((e) => {
        const from = graph.nodes.find((n) => n.id === e.from)!;
        const to = graph.nodes.find((n) => n.id === e.to)!;
        return (
          <line
            key={e.id}
            x1={from.x + 130}
            y1={from.y + 50}
            x2={to.x + 130}
            y2={to.y + 50}
            stroke="#94a3b8"
            strokeWidth={2}
          />
        );
      })}
      {graph.nodes.map((n) => (
        <g key={n.id} onClick={() => onSelect(n.id)} className="cursor-pointer">
          <rect x={n.x} y={n.y} width={260} height={100} rx={12} className="fill-white stroke-slate-300" />
          <text x={n.x + 12} y={n.y + 24} className="fill-slate-900 text-sm font-medium">
            {n.label}
          </text>
          <text x={n.x + 12} y={n.y + 48} className="fill-slate-500 text-xs">
            {n.type}
          </text>
          {n.layer !== undefined && (
            <text x={n.x + 12} y={n.y + 76} className="fill-slate-400 text-[10px]">
              layer {n.layer}
            </text>
          )}
        </g>
      ))}
    </svg>
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
- **画布：** v1 纯 SVG 只读，直接消费 `@chengchenccc/workflow` `toEditorGraph`/`layeredLayout`；v2 拖拽连线再引入 `@xyflow/react`。
- **测试：** 该 plan 以 typecheck/lint + backend http test 为主；真 DOM 渲染验证（headless Chrome）留到 Plan 3 最终联调的一步，按仓库既有记忆模式。
