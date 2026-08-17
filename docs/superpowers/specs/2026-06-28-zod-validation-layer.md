# 类型归一化：drizzle-zod 统一真相源

> 状态：spec（含全表审计）
> 基准 HEAD：`abc0c1ee`（ORM 归位 + DI 瘦身 + heartbeat 清理完成）

## 0. 出发点

当前系统中，同一个领域对象从 DB 到前端经过 4-5 层，每层手写自己的类型。已经出现多处漂移。

### 类型链

```
drizzle schema → store mapper → service DTO → HTTP response → frontend type
  (真相源)        (手写)         (手写)        (隐式)         (手写)
```

### 审计结论：15 张表全查

| 表 | 后端类型数 | 前端类型数 | 漂移 |
|----|----------|----------|------|
| `run` | 4 (store×3 + DTO×2 + listSessions) | 2 (ListItem + Detail) | ❌ `runId`/`parentRunId` 仍是旧名；`heartbeatAgeMs`/`transport` 已删于后端 |
| `attempt` | 1 (store×2 内联) | 内嵌于 RunOpsDetail | ❌ 前端仍有 `heartbeatAt`/`transport` |
| `control_plane_event` | 2 (types.ts + service ops 内联重复) | 无独立类型 | ❌ service ops 手写了一模一样的 fields 而不是引用 types.ts |
| `run_origin` | 1 (SpanOriginRow) | 无 | ⚠️ `issueId?` 用 `?` 可选 vs schema 是 nullable |
| `surface_health` | 2 (SurfaceHealthRow + AgentRuntimeStatus 手写) | 1 (AgentRuntimeStatus) | ⚠️ AgentRuntimeStatus.surfaces 手写 |
| `issue` | 1 (IssueRow) | 1 (IssueRow) | ⚠️ status/priority 是裸 string vs union type |
| `project` | 1 (adapter 内) | 1 (ProjectRow) | ❌ `autoOrchestrate: boolean` vs schema `integer` |
| `column_config` | 1 (adapter 内) | 1 (ColumnConfigRow) | ❌ 前端缺 `approvalPosture` 字段 |
| `cron_job` | 1 (CronJobRow) | 1 (CronJobRow) | ❌ `enabled: boolean` vs schema `integer` |
| `deliverable` | 1 (adapter 内) | 无独立 | — |
| `agents` | 1 (AgentRow) | 1 (AgentRow + LarkConfig) | ⚠️ `archivedAt?` 可选 vs schema nullable；前端多 `lark` 计算字段 |
| `issue_event` | 1 (IssueEvent) | 1 (IssueEvent) | ❌ `payload: Record` vs schema `text`（JSON 字符串） |
| `conversation` | 1 (ConversationRow) | 1 (ConversationSnapshot) | ✓ 使用共享包 `@chengchenccc/conversation`（好模式） |
| `member` | 1 (MemberRow) | 1 (MemberInfo = Member) | ✓ 同上 |
| `conversation_ledger` | 1 (LedgerEntry) | 1 (LedgerEntry) | ✓ 同上 |

**严重漂移（❌）：`run` 全家桶、`project`、`column_config`、`cron_job`、`issue_event`**

### 根因

没有单向推导链。drizzle schema 能给出 `$inferSelect`，但没人用——每层都自己手写 interface。改 schema 时无法传播到下游。

## 1. 方案

用 `drizzle-zod` 从 drizzle table 自动生成 Zod schema，作为全链路的唯一类型真相源：

```
drizzle schema ──drizzle-zod──→ Zod schema ──z.infer──→ TS types
   (唯一真相)                      │                    │
                                   │                    ├── store 返回类型
                                   │                    ├── service DTO
                                   │                    └── 导出给前端复用
                                   │
                                   ├── parse/transform (JSON string ↔ object)
                                   └── HTTP body 校验
```

### 收益

| Before | After |
|--------|-------|
| 15 表 × 3 层 = ~45 处手写类型 | 15 个 Zod schema，类型推导 |
| `runId`/`parentRunId` 漂移 | 改 schema 一处，全链更新 |
| `payload`/`fields`/`addressedTo` JSON 散落 | 集中在 schema 的 `.transform()` |
| `boolean` vs `integer` 不一致 | drizzle-zod 自动从列类型推导 |
| HTTP body 手写 `typeof` 判断 | `schema.safeParse(body)` |

## 2. 施工范围

### Phase 1：安装 drizzle-zod + 15 表生成 schema

- 安装 `drizzle-zod`
- 为全部 15 张表导出 `{Table}SelectSchema` 和 `{Table}InsertSchema`
- JSON 字符串列（`payload`, `fields`, `addressedTo`, `content`）加 `.transform(JSON.parse/stringify)`
- `integer` 布尔列（`enabled`, `autoOrchestrate`, `checkpointerOk` 等）加 `.transform(Boolean)`

### Phase 2：替换 store.ts + types.ts

- 删 3 个手动 mapper（`toControlPlaneEventRecord`, `toSpanOriginRow`, `toSurfaceHealthRow`）
- `types.ts` 的 `ControlPlaneEvent`, `SpanOriginRow`, `SurfaceHealthRow` → `z.infer<typeof ...Schema>`
- `store.ts` 方法返回类型 → 从 Zod 推导

### Phase 3：替换 service.ts DTO

- `RunOpsListItem` → 从 Zod schema 推导 + 计算字段组合
- `RunOpsDetail` → 同上
- `RunOpsDetail.ops: Array<{...}>` → 复引用 `ControlPlaneEvent`
- `listSessions` / `getSessionDetail` 返回类型 → 从 Zod schema 推导

### Phase 4：HTTP body 校验 Zod 化

- `runtime-ops/http.ts`：`larkHeartbeat` → `SurfaceHealthInsertSchema`
- `issue/http.ts`：create/transition → `IssueInsertSchema`
- `conversation/http.ts`：message → `LedgerInsertSchema`
- `agent/http.ts`：已有 Zod，不动

### Phase 5：前端类型对齐

- `apps/web/src/lib/api.ts`：`RunOpsListItem.runId` → `spanId`，`parentRunId` → `parentSpanId`
- 删 `heartbeatAgeMs`, `runnerTransport`, `transport`, `heartbeatAt`（已在后端删除）
- `ProjectRow.autoOrchestrate: boolean` → `number`（或后端加 transform）
- `CronJobRow.enabled: boolean` → `number`（或后端加 transform）
- `ColumnConfigRow` 补 `approvalPosture`
- `IssueEvent.payload` → `string`（或后端加 transform 传 object）

### Phase 6：adapter 层对齐

- `agent/adapter-sqlite.ts` 等 adapter 返回类型 → `$inferSelect`
- `conversation/ports.ts` → 保持共享包类型（已是好模式）

## 3. 涉及文件

| 文件 | 改动 |
|------|------|
| `infra/db/schema.ts` | 15 表 × 2 schema（select + insert）+ JSON/boolean transform |
| `runtime-ops/store.ts` | 删 mapper，返回类型推导 |
| `runtime-ops/types.ts` | 接口 → `z.infer<>` |
| `runtime-ops/service.ts` | DTO → 推导类型 |
| `runtime-ops/http.ts` | body → Zod 校验 |
| `issue/http.ts` | body → Zod 校验 |
| `conversation/http.ts` | body → Zod 校验 |
| `*/adapter-sqlite.ts` | 返回类型 → `$inferSelect` |
| `apps/web/src/lib/api.ts` | 前端类型对齐后端 |
| `package.json` | +`drizzle-zod` |

## 4. 不做

- `buildRunQuery` 动态 SQL
- `listSessions` GROUP BY（聚合结果不是表行，不能从 schema 推导）
- `@chengchenccc/conversation` 共享包（已是正确模式——conversation/member/ledger 通过 canonical package 导出）
- 前端组件重构

## 5. 关联

- 存储面收敛 spec `2026-06-27-storage-convergence.md`
- ORM+DI cleanup spec `2026-06-28-orm-and-di-cleanup.md`
