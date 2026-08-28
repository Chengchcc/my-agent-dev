# Agentic Workflow Plan 5: Trigger 入 DSL + Cron 简化 + loop 删除

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ① 触发器进 DSL（`triggers: [{type:"cron", cron, enabled?}]`，file-first：一个文件 = 完整 workflow 含调度）；② Cron 功能简化——未来只服务 workflow，删掉 agent/loop 目标和 CronJob 表/UI，换成"扫描 DSL 触发器注册 Bun.cron"的 trigger-scheduler；③ 彻底删除 loop feature（backend + web + skills + 表）。

**Architecture:** DSL 是触发器的唯一真相源。backend workflow feature 新增 `trigger-scheduler.ts`：boot 时 + 每次 PUT/DELETE 定义后，扫描 `dataDir/workflows/*.workflow.json` 的 `triggers`，用 `Bun.cron` 注册，fire 时 `startExecution`。CronJob feature（表/service/http/scheduler/web UI）整体删除。

**Tech Stack:** Elysia, Drizzle + SQLite, Bun.cron, React 19, bun:test。

**范围外：** agent-run 的 cron 触发（用户决定后续只用 workflow）、LOOP.md 转换、历史数据迁移。

---

## 文件结构

```
# ① DSL triggers
packages/workflow/src/types.ts           # + CronTrigger/WorkflowTrigger + WorkflowDefinition.triggers
packages/workflow/src/parse.ts           # + triggers 校验
skills/agentic-workflow-dsl/SKILL.md     # + triggers 文档
skills/agentic-workflow-dsl/reference/validate.js  # + triggers 规则
apps/backend/src/features/workflow/showcase/nighttime-report.workflow.json  # + cron trigger

# ② workflow trigger-scheduler（新增）
apps/backend/src/features/workflow/trigger-scheduler.ts
apps/backend/src/features/workflow/http.ts      # PUT/DELETE 后 resyncTriggers
apps/backend/src/bootstrap/features.ts          # 创建 + start/dispose

# ③ 删除 CronJob feature + loop feature
DELETE: apps/backend/src/features/cron/
DELETE: apps/backend/src/features/loop/
DELETE: apps/web/src/features/cron/
DELETE: apps/web/src/features/loop/
DELETE: apps/web/src/components/CronJobForm.tsx
DELETE: apps/web/src/app/(main)/work/           # loop UI
DELETE: apps/web/src/components/work/
DELETE: skills/loop-engine/
DELETE: skills/loop-workflow/
apps/backend/src/infra/db/schema.ts            # - cronJob/loopItem/loopBudget
apps/backend/drizzle/backend/0042_drop_cron_job.sql
apps/backend/drizzle/backend/0043_drop_loop_tables.sql
apps/web/src/lib/api.ts                         # - cron/loop methods
apps/backend/src/app.ts                         # - cronJobs/loops
apps/web/src/app/(main)/system/page.tsx         # - cron section
apps/web/src/components/NavRail.tsx             # - loop entries
AGENTS.md                                       # 表数 24→21、目录行清理
```

---

### Task 1: DSL 加 triggers（cron）

**Files:**
- Modify: `packages/workflow/src/types.ts`
- Modify: `packages/workflow/src/parse.ts`
- Modify: `skills/agentic-workflow-dsl/SKILL.md`
- Modify: `skills/agentic-workflow-dsl/reference/validate.js`
- Modify: `apps/backend/src/features/workflow/showcase/nighttime-report.workflow.json`

- [ ] **Step 1: types.ts**

```typescript
export interface CronTrigger {
  type: "cron";
  /** 5-field cron expression, UTC. */
  cron: string;
  enabled?: boolean;
}
export type WorkflowTrigger = CronTrigger;

export interface WorkflowDefinition {
  version: 1;
  id: string;
  meta?: WorkflowMeta;
  /** Trigger declarations. API trigger is implicit (any workflow can be
   *  invoked via POST /api/workflow-executions). */
  triggers?: WorkflowTrigger[];
  input?: InputHint;
  nodes: WorkflowNode[];
  edges: EdgeDef[];
}
```

- [ ] **Step 2: parse.ts 校验 triggers**

```typescript
const triggers: WorkflowTrigger[] = [];
if (raw.triggers !== undefined) {
  if (!Array.isArray(raw.triggers)) issues.push("triggers must be an array");
  else {
    for (const [i, t] of raw.triggers.entries()) {
      if (typeof t !== "object" || t === null) { issues.push(`triggers[${i}] must be an object`); continue; }
      const tr = t as Record<string, unknown>;
      if (tr.type !== "cron") { issues.push(`triggers[${i}].type must be "cron"`); continue; }
      if (typeof tr.cron !== "string" || tr.cron.trim() === "") { issues.push(`triggers[${i}].cron must be a non-empty string`); continue; }
      const entry: WorkflowTrigger = { type: "cron", cron: tr.cron };
      if (tr.enabled !== undefined) {
        if (typeof tr.enabled !== "boolean") issues.push(`triggers[${i}].enabled must be boolean`);
        else entry.enabled = tr.enabled;
      }
      triggers.push(entry);
    }
  }
}
// def 构造后：if (triggers.length > 0) def.triggers = triggers;
```

- [ ] **Step 3: SKILL.md + validate.js 加 triggers 规则**

SKILL.md Shape 加 `triggers` 字段说明；Validate 清单加一条：`triggers` 为数组，每项 `{type:"cron", cron:"<5-field expr>", enabled?}`。validate.js 对应实现。

- [ ] **Step 4: showcase 加 cron trigger**

`nighttime-report.workflow.json` 加：

```json
"triggers": [{ "type": "cron", "cron": "0 2 * * *" }]
```

- [ ] **Step 5: 测试 + typecheck**

packages/workflow 补 parse 测试（triggers 合法/非法）；`cd packages/workflow && bun test && bun run typecheck`；重建 dist（backend 消费）。

- [ ] **Step 6: Commit**

```bash
git add packages/workflow skills/agentic-workflow-dsl apps/backend/src/features/workflow/showcase
git commit -m "feat(workflow): declare cron triggers in the workflow dsl"
```

---

### Task 2: workflow trigger-scheduler

**Files:**
- Create: `apps/backend/src/features/workflow/trigger-scheduler.ts`
- Modify: `apps/backend/src/features/workflow/http.ts`
- Modify: `apps/backend/src/bootstrap/features.ts`

- [ ] **Step 1: trigger-scheduler.ts**

```typescript
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { parseWorkflow, type WorkflowDefinition } from "@chengchenccc/workflow";

export interface WorkflowTriggerScheduler {
  sync(): Promise<void>;
  dispose(): Promise<void>;
}

export interface WorkflowTriggerSchedulerDeps {
  workflowDir: string;
  startExecution(input: { workflowId: string; definition: WorkflowDefinition; input: Record<string, unknown> }): Promise<unknown>;
  /** Scheduler registry (bunScheduler: Bun.cron wrapper). */
  schedule(cronExpr: string, fn: () => void): { stop(): void };
}

export function createWorkflowTriggerScheduler(deps: WorkflowTriggerSchedulerDeps): WorkflowTriggerScheduler {
  const handles = new Map<string, ReturnType<typeof deps.schedule>[]>();
  const single = new Set<string>(); // per-workflow single-flight

  function loadDefinitions(): WorkflowDefinition[] {
    return readdirSync(deps.workflowDir)
      .filter((f) => f.endsWith(".workflow.json"))
      .map((f) => parseWorkflow(JSON.parse(readFileSync(join(deps.workflowDir, f), "utf8"))));
  }

  async function fire(workflowId: string): Promise<void> {
    if (single.has(workflowId)) return;
    single.add(workflowId);
    try {
      const defs = loadDefinitions();
      const def = defs.find((d) => d.id === workflowId);
      if (!def) return;
      await deps.startExecution({ workflowId: def.id, definition: def, input: {} });
    } finally {
      single.delete(workflowId);
    }
  }

  return {
    async sync() {
      for (const hs of handles.values()) for (const h of hs) h.stop();
      handles.clear();
      for (const def of loadDefinitions()) {
        const list: ReturnType<typeof deps.schedule>[] = [];
        for (const t of def.triggers ?? []) {
          if (t.type === "cron" && t.enabled !== false) {
            list.push(deps.schedule(t.cron, () => void fire(def.id)));
          }
        }
        handles.set(def.id, list);
      }
    },
    async dispose() {
      for (const hs of handles.values()) for (const h of hs) h.stop();
      handles.clear();
    },
  };
}
```

- [ ] **Step 2: http.ts PUT/DELETE 后 resync**

`workflowRoutes` deps 加 `resyncTriggers: () => Promise<void>`；PUT/DELETE 定义成功后 `void deps.resyncTriggers()`。

- [ ] **Step 3: bootstrap 接线**

```typescript
const workflowTriggerScheduler = createWorkflowTriggerScheduler({
  workflowDir: join(config.dataDir, "workflows"),
  schedule: (expr, fn) => { const h = Bun.cron(expr, fn); return { stop: () => h.stop() }; },
  startExecution: (input) => workflowExecutionService.startExecution(input),
});
// workflowRoutes deps: resyncTriggers: () => workflowTriggerScheduler.sync()
// start(): await workflowTriggerScheduler.sync();
// dispose(): await workflowTriggerScheduler.dispose();
```

- [ ] **Step 4: 测试**

trigger-scheduler.test：给定 tmp workflowDir 写一个带 cron trigger 的 DSL，fake schedule 捕获注册；sync 注册；PUT/DELETE 后 resync 重新注册/注销。

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/features/workflow apps/backend/src/bootstrap/features.ts
git commit -m "feat(workflow): schedule cron triggers from workflow dsl"
```

---

### Task 3: 删除 CronJob feature

**Files:**
- DELETE: `apps/backend/src/features/cron/`
- DELETE: `apps/web/src/features/cron/`
- DELETE: `apps/web/src/components/CronJobForm.tsx`
- Modify: `apps/backend/src/app.ts`
- Modify: `apps/backend/src/bootstrap/features.ts`
- Modify: `apps/web/src/app/(main)/system/page.tsx`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/backend/src/infra/db/schema.ts`
- Create: `apps/backend/drizzle/backend/0042_drop_cron_job.sql`

- [ ] **Step 1: 删 backend cron feature + 清引用**

`rm -rf apps/backend/src/features/cron/`。app.ts 删 `cronJobRoutes`/`cronJobs` key/`.use(cronJobs)`。bootstrap/features.ts 删 cron import + `cronSvc`/`cronScheduler` 创建 + start/dispose 里的 cron 调用。schema.ts 删 `cronJob` 表。migration `0042_drop_cron_job.sql`：`DROP TABLE IF EXISTS cron_job;`（journal idx 42）。

- [ ] **Step 2: 删 web cron UI**

`rm -rf apps/web/src/features/cron/ apps/web/src/components/CronJobForm.tsx`。system/page.tsx 删 cron section。api.ts 删 cron 方法/类型（`listCronJobs`/`createCronJob`/`updateCronJob`/`deleteCronJob`/`CronJobRow`）。

- [ ] **Step 3: typecheck + 修复残余**

`cd apps/backend && bun run typecheck && cd ../web && bun run typecheck`，修所有残余引用。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(workflow): remove cron job feature in favor of dsl triggers"
```

---

### Task 4: 删除 loop feature（backend + web + skills + 表）

**Files:**
- DELETE: `apps/backend/src/features/loop/`
- DELETE: `apps/web/src/features/loop/`
- DELETE: `apps/web/src/app/(main)/work/`
- DELETE: `apps/web/src/components/work/`
- DELETE: `skills/loop-engine/`
- DELETE: `skills/loop-workflow/`
- Modify: `apps/backend/src/app.ts`（删 loops route）
- Modify: `apps/backend/src/bootstrap/features.ts`（删 loop import/装配/doctor）
- Modify: `apps/backend/src/bootstrap/services.ts`（删 loopStore）
- Modify: `apps/web/src/components/NavRail.tsx`（删 Work/New Loop）
- Modify: `apps/web/src/lib/api.ts`（删 loop 方法/类型）
- Modify: `apps/backend/src/infra/db/schema.ts`（删 loopItem/loopBudget）
- Create: `apps/backend/drizzle/backend/0043_drop_loop_tables.sql`

- [ ] **Step 1: 删 backend loop + 清引用**

`rm -rf apps/backend/src/features/loop/`。app.ts 删 `loops`。bootstrap/features.ts 删 `loopRoutes`/`runLoopDoctor`/`createLoopLockRegistry`/`loopLocks`/`loopStore` 装配 + start() 的 Loop Doctor 块 + dispose 清理。services.ts 删 `loopStore`。schema.ts 删 `loopItem`/`loopBudget`。migration `0043_drop_loop_tables.sql`：`DROP TABLE IF EXISTS loop_item;--> statement-breakpoint\nDROP TABLE IF EXISTS loop_budget;`（journal idx 43）。

- [ ] **Step 2: 删 web loop UI**

`rm -rf apps/web/src/features/loop/ apps/web/src/app/(main)/work/ apps/web/src/components/work/`。NavRail 删 Today/New Loop 入口。api.ts 删 loop 方法/类型。

- [ ] **Step 3: 删 loop skills**

`rm -rf skills/loop-engine/ skills/loop-workflow/`。检查 `skills/workflow-authoring` 是否 loop 独占——grep 引用；若只被 loop 用则一并删。

- [ ] **Step 4: typecheck + 修复残余**

`cd apps/backend && bun run typecheck && cd ../web && bun run typecheck`，修残余。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(workflow): remove loop feature and loop skills"
```

---

### Task 5: 全量收口 + audit

- [ ] **Step 1: AGENTS.md 更新**

表数 24→21（删 cron_job/loop_item/loop_budget）。Key Directories 删 loop 行。Important Files 删 loop-reducer 行。AGENTS.md 加 `apps/backend/src/features/workflow/` 行。

- [ ] **Step 2: commitlint scope 清理**

`commitlint.config.mjs` scope-enum 删 `"cron"`（若不再用）；`"workflow"` 保留。

- [ ] **Step 3: 全量门禁**

```bash
bun run audit            # audit:contracts + audit:docs（表数/目录行同步）
bun run typecheck        # root 33/33
cd apps/backend && bun test
cd apps/web && bun run typecheck && bun run lint
cd apps/oh-my-agent && bun test
cd packages/workflow && bun test
```

- [ ] **Step 4: 迁移验证**

`openDb(":memory:")` 套 0000–0043，`PRAGMA table_info` 确认 cron_job/loop_* 不存在、workflow 四表存在、showcase 播种成功。

- [ ] **Step 5: Commit + push**

```bash
git add -A
git commit -m "feat(workflow): final gates for triggers and loop removal"
git push origin master
```

---

## 备注

- **触发器唯一真相源 = DSL**：`triggers` 数组。API trigger 是隐式的（任何 workflow 都能 POST 启动），不在 DSL 里声明。
- **CronJob 表删除后**：web 的 system/cron 管理页一并删；workflow 编辑器的 DSL 面板成为触发器唯一的编辑入口。
- **loop 删除**：loop 历史数据（loop_item/loop_budget 行、.loop/ 目录）直接废弃，DROP TABLE，不做搬迁。
- **single-flight**：workflow trigger 的 per-workflow 防重叠在 trigger-scheduler 的 `single` Set 里；与原 cron scheduler 的 `inFlight` 同语义。
- **input 注入**：v1 cron fire `input: {}`；后续可加 `triggers[i].input`（静态 JSON）做 trigger 变量注入。
