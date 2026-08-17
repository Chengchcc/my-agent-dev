# 类型裂化修复 Plan

> 基于 2026-06-30 审计，对照 `e2e-contract-rules.md` 和 `db-typesafe-rules.md` 的自检 grep 命中。

## 审计命令

```bash
# E2E 规则自检
grep -rn "apiFetch<\|as IssueStatus\|as AgentRow" apps/web/src
grep -rn "queryKey:\|queryFn:\|client\.api\." apps/web/src/{app,components}
grep -rn "new EventSource\|\`.*\/events\`" apps/web/src
grep -rn "process\.env\." apps/{backend,web,lark-bot}/src
grep -rn "as {\|as Record<" apps/lark-bot/src

# DB 规则自检
grep -rn "interface.*Row\b" apps/backend/src/features/ | grep -v entities.ts
grep -rn 'JSON.parse(.*) as [A-Z]' apps/backend/src/features/
grep -rn ' as [A-Z][a-z]*Row\b' apps/backend/src/features/
grep -rn 'type.*Status.*=.*".*".*".*"' apps/backend/src/features/
grep -rn '!!.*\.enabled\|!!.*\.autoOrchestrate\|.*enabled.*? 1 : 0' apps/backend/src/features/
```

## 发现总览

| # | 严重度 | 问题 | 文件数 | 行数 |
|---|--------|------|--------|------|
| F1 | 🔴 | InsertSchema 缺失：int-bool 写入无类型护栏 | 3 | 6 |
| F2 | 🟠 | JSON 列裸 `JSON.parse + as T` | 2 | 2 |
| F3 | 🟠 | lark-bot 跨进程数据 `as Record<string, unknown>` | 2 | 4 |
| F4 | 🟡 | web SSE URL 手写模板，未进 `sseEndpoints` | 1 | 1 |

已排除的误报见文末 §排除项。

---

## F1：InsertSchema 缺失 — int-bool 写入无类型护栏

### 问题

`schema.ts` 为 3 个 int-bool 列定义了 **SelectSchema**（读路径：`int(0|1) → boolean`）：

```ts
// schema.ts:309
export const agentsSelectSchema = createSelectSchema(agents, {
  larkEnabled: (s) => s.transform((v: number) => v !== 0),
});
// schema.ts:340
export const projectSelectSchema = createSelectSchema(project, {
  autoOrchestrate: (s) => s.transform((v: number) => v !== 0),
});
// schema.ts:344
export const cronJobSelectSchema = createSelectSchema(cronJob, {
  enabled: (s) => s.transform((v: number) => v !== 0),
});
```

但 **没有对应的 InsertSchema**。写入路径依赖 6 处手工 `? 1 : 0`：

```ts
// agent/adapter-sqlite.ts:34,71
larkEnabled: input.larkEnabled ? 1 : 0,

// cron/adapter-sqlite.ts:21,65
enabled: input.enabled ? 1 : 0,

// project/adapter-sqlite.ts:21,51
autoOrchestrate: input.autoOrchestrate ? 1 : 0,
```

### 风险

- 新 contributor 在 adapter 里写 `values({ enabled: true })`，drizzle 存 `true`（非 0）到 integer 列 → SQLite 接受（弱类型），`v !== 0` transform 仍工作 → **不报错但 DB 数据脏了**
- 若未来有人重构 adapter 删掉 `? 1 : 0`，InsertSchema 无兜底 → 静默错误
- 与 `db-typesafe-rules.md` §5 "int bool 不得在业务代码手动转换" 直接冲突

### 修复

**Step 1: 补 InsertSchema + 反向 transform**

```ts
// schema.ts — 新增，放在现有 SelectSchema 附近

export const agentsInsertSchema = createInsertSchema(agents, {
  larkEnabled: (s) => s.transform((v: boolean) => v ? 1 as const : 0 as const),
});

export const cronJobInsertSchema = createInsertSchema(cronJob, {
  enabled: (s) => s.transform((v: boolean) => v ? 1 as const : 0 as const),
});

export const projectInsertSchema = createInsertSchema(project, {
  autoOrchestrate: (s) => s.transform((v: boolean) => v ? 1 as const : 0 as const),
});
```

> `as const` 是必需的：drizzle-zod transform 返回 `number`，但 drizzle-kit 的 column type 需要 literal `0 | 1`。`as const` 收窄类型。

**Step 2: adapter 走 InsertSchema.parse()，删除手工 `? 1 : 0`**

以 `agent/adapter-sqlite.ts` 为例：

```ts
// before
db.insert(agents).values({
  ...input,
  larkEnabled: input.larkEnabled ? 1 : 0,
});
// after
const validated = agentsInsertSchema.parse(input);
db.insert(agents).values(validated);
```

> 如果 insert 中有 InsertSchema 未覆盖的列（如 `id`、`createdAt`），用 spread: `{ ...input, ...validated }` 或只覆盖 int-bool 列。

**Step 3: 确认 SelectSchema 类型与 InsertSchema 输入类型对齐**

`agentsSelectSchema.parse(row)` 返回类型中 `larkEnabled` 是 `boolean`。`agentsInsertSchema.parse(input)` 输入类型中 `larkEnabled` 应为 `boolean`。验证 tsc。

### 涉及文件

| 文件 | 操作 |
|------|------|
| `apps/backend/src/infra/db/schema.ts` | 新增 3 个 InsertSchema + transform |
| `apps/backend/src/features/agent/adapter-sqlite.ts` | 用 InsertSchema，删 `? 1 : 0` ×2 |
| `apps/backend/src/features/cron/adapter-sqlite.ts` | 用 InsertSchema，删 `? 1 : 0` ×2 |
| `apps/backend/src/features/project/adapter-sqlite.ts` | 用 InsertSchema，删 `? 1 : 0` ×2 |

### 验收

```bash
cd apps/backend && bun run typecheck   # 0 error
cd apps/backend && bun test            # 304 pass / 3 skip / 0 fail
# grep 自检归零：
grep -rn '\? 1 : 0\|\? 0 : 1' apps/backend/src/features/
```

---

## F2：JSON 列裸解析

### 问题

`schema.ts` 的 `conversation_ledger.content` 和 `checkpoint_events.event` 是 JSON 文本列，读取时未走 drizzle-zod codec：

```ts
// conv-svc-factory.ts:60
const parsed = typeof e.content === "string"
  ? (JSON.parse(e.content) as Record<string, unknown>)
  : (e.content as Record<string, unknown>);

// checkpoint-events-store.ts:32
const event = JSON.parse(r.event) as CheckpointEvent;
```

### 风险

- `content` 损坏 → `Record<string, unknown>` 不报错，下游 `.role` / `.text` 读到 `undefined`
- `event` 字段缺失 → `as CheckpointEvent` 不报错，排障/Ops 页面渲染异常
- 与 `db-typesafe-rules.md` §3 "禁止 `JSON.parse(row.x) as T`" 直接冲突

### 修复

**F2a: conv-svc-factory.ts**

`content` 存的是 `serializeMessageRevision()` 的产物 → 用 `MessageRevisionSchema` 验证：

```ts
// before
const parsed = typeof e.content === "string"
  ? (JSON.parse(e.content) as Record<string, unknown>)
  : (e.content as Record<string, unknown>);
// after
import { MessageRevisionSchema, deserializeLedgerContent } from "@chengchenccc/message";
const revision = deserializeLedgerContent(e.content);
```

> 注：`conv-svc-factory.ts` 已有 `@chengchenccc/message` 的 import（`serializeMessageRevision`、`extractText` 等），只需确认 `deserializeLedgerContent` 是否导出。若未导出，在 `packages/message/src/helpers.ts` 补一个导出。

**F2b: checkpoint-events-store.ts**

`event` 存的是 `CheckpointEvent` JSON → 定义 zod schema 并 parse：

```ts
// before
const event = JSON.parse(r.event) as CheckpointEvent;
// after
const event = CheckpointEventSchema.parse(JSON.parse(r.event));
```

需要在 `packages/framework/src/checkpointer.ts` 导出 `CheckpointEvent` 的 zod schema。当前只导出了 TS type。若不想改 framework，可在 `checkpoint-events-store.ts` 本地定义 schema（但从真源原则应放在 framework）。

> **风险提示**：若 `checkpoint_events` 表中有历史脏数据（损坏的 JSON、缺失字段），`parse()` 会抛异常。需确认当前 DB 中无脏数据，或改用 `safeParse` + 日志跳过。

### 涉及文件

| 文件 | 操作 |
|------|------|
| `apps/backend/src/features/conversation/conv-svc-factory.ts` | 替换裸解析 |
| `apps/backend/src/features/runtime-ops/checkpoint-events-store.ts` | 替换裸解析 |
| `packages/framework/src/checkpointer.ts`（可选） | 导出 `CheckpointEventSchema` |
| `packages/message/src/helpers.ts`（可选） | 确认 `deserializeLedgerContent` 导出 |

### 验收

```bash
cd apps/backend && bun run typecheck   # 0 error
grep -rn 'JSON.parse(.*) as [A-Z]' apps/backend/src/features/   # 期望 0
```

---

## F3：lark-bot 跨进程数据裸断言

### 问题

lark-bot 调用后端 API，响应在 4 处被断言为 `Record<string, unknown>`：

```ts
// bootstrap.ts:67 — GET /api/agents/:id
const record = data! as unknown as Record<string, unknown>;
if (record.larkEnabled === false) { ... }

// ingest.ts:110 — POST /api/conversations 响应
conversationId = (convData as unknown as Record<string, unknown>).conversationId as string;

// ingest.ts:175 — POST /api/conversations/:id/messages 响应
const body = msgData as unknown as Record<string, unknown>;
const seq = body.seq as number;
```

### 风险

- 后端改字段名 → lark-bot 静默读 `undefined`，不报错
- 与 `e2e-contract-rules.md` §1 "禁止裸 fetch + as" 冲突

### 修复

**bootstrap.ts**：`GET /api/agents/:id` 的响应类型已在 `api-contract` 的 `App` 类型中。改用 Eden treaty client（`apps/lark-bot/src/client.ts` 已有 `createClient`）：

```ts
// before
const url = `${backendUrl}/api/agents/${agentId}`;
const resp = await fetch(url, { headers });
const data = await resp.json();
const record = data! as unknown as Record<string, unknown>;
// after
const client = createClient(backendUrl, backendAuthToken);
const { data, error } = await client.api.agents({ id: agentId }).get();
if (error) { /* handle */ }
// data is fully typed via treaty<App>
```

> **风险**：`bootstrap.ts` 是启动路径。改 Eden client 后若 treaty 类型链断裂（backend `App` 类型未正确 export 到 `api-contract`），lark-bot 启动会崩。先 `typecheck` 确认。

**ingest.ts**：同上，已有 `client.ts`，直接走 Eden：

```ts
// before (line 96-110)
const resp = await fetch(`${backendUrl}/api/conversations`, { ... });
const convData = await resp.json();
conversationId = (convData as unknown as Record<string, unknown>).conversationId as string;
// after
const { data: conv, error } = await client.api.conversations.post({ ... });
if (error) throw new Error(...);
conversationId = conv.conversationId; // typed
```

> **风险**：`ingest.ts` 在 `reserveInbound()` 事务内做了多次 HTTP 调用。改为 Eden 后需保持 0→1→2 三步顺序不变（先 reserve → 再 POST → 最后 confirm）。Eden 是 Promise-based，不影响事务逻辑。

### 涉及文件

| 文件 | 操作 |
|------|------|
| `apps/lark-bot/src/bootstrap.ts` | fetch → Eden client |
| `apps/lark-bot/src/ingest.ts` | fetch → Eden client ×2 |
| `apps/lark-bot/src/client.ts` | 确认 Eden client 类型配置 |

### 验收

```bash
cd apps/lark-bot && bun run typecheck   # 0 error
grep -rn 'as unknown as Record<string, unknown>' apps/lark-bot/src/   # 期望 0（测试除外）
```

---

## F4：web SSE URL 手写模板

### 问题

```ts
// IssueDetailSheet.tsx:132
const ts = typedSource(
  `/api/bff/api/issues/${issue.issueId}/timeline/events`,
  issueTimelineEvents,
);
```

### 风险

- 后端改路由 path → web 不报编译错，运行时 404
- `typedSource` + `issueTimelineEvents` schema map 保证了 payload 校验，**风险低于 F1-F3**
- 与 `e2e-contract-rules.md` §1 "SSE URL 必须从 sseEndpoints 注册表取" 冲突

### 修复

在 `api-contract/src/sse.ts` 的 `sseEndpoints` 注册表中注册 issue timeline endpoint：

```ts
// api-contract/src/sse.ts
export const sseEndpoints = {
  // ... existing
  issueTimeline: (issueId: string) => ({
    path: `/api/bff/api/issues/${issueId}/timeline/events`,
    events: issueTimelineEvents,
  }),
} as const;
```

web 侧改用 `openSSE("issueTimeline", { issueId })`：

```ts
// IssueDetailSheet.tsx
const ts = openSSE("issueTimeline", { issueId: issue.issueId });
```

> **风险**：`openSSE` 当前可能不支持参数化 path。需检查 `typedSource` 的签名和 `sseEndpoints` 的实现是否支持函数型 endpoint。若不支持，此修复需先改 `typedSource` 的接口。

### 涉及文件

| 文件 | 操作 |
|------|------|
| `packages/api-contract/src/sse.ts` | 注册 issueTimeline endpoint |
| `apps/web/src/components/IssueDetailSheet.tsx` | 改用 `openSSE` |
| `apps/web/src/lib/typed-source.ts`（可能） | 扩展 `openSSE` 支持参数 |

### 验收

```bash
cd apps/web && bun run typecheck   # 0 error
grep -rn '`.*\/events`' apps/web/src   # 期望 0（或在 typedSource/sseEndpoints 内）
```

---

## 排除项（误报，无需修）

| 命中 | 文件 | 原因 |
|------|------|------|
| `interface AgentRow` | `agent/domain.ts` | 非 drizzle adapter 的规范类型 |
| `interface ColumnConfigRow` | `column-config/domain.ts` | 同上 |
| `interface ConversationRow` | `conversation/ports.ts` | conversation 用 raw SQLite，非 drizzle |
| `interface MemberRow` | `conversation/ports.ts` | 同上 |
| `interface CronJobRow` | `cron/domain.ts` | 同上 |
| `interface DeliverableRow` | `deliverable/domain.ts` | 同上 |
| `interface ProjectRow` | `project/domain.ts` | 同上 |
| `as MemberRow` ×5 | `conversation/adapter-sqlite.ts` | zod parse 后的冗余断言，无害 |
| `LarkBotStatus` | `lark-bot/registry.ts` | 本地枚举，无共享副本 |
| `process.env.BACKEND_URL` | `lark-bot/args.test.ts` | 测试 env 操作，非业务代码 |
| `process.env` in `args.ts` | `lark-bot/args.ts` | 已走 `parseEnv(process.env)` |
| `new EventSource` | `web/lib/typed-source.ts` | 在 wrapper 内部，符合规则 |
| `as IssueStatus` ×2 | `web/IssueKanban.tsx` | 类型来自共享源 `api-contract` |
| `queryKey:` ×N in components | web components | 全部用 `XxxKeys.xxx()` 工厂 |

---

## 执行顺序建议

```
F1 (InsertSchema)  →  F2a (ledger content parse)  →  F2b (checkpoint event parse)
                   ↘  F3 (lark-bot Eden client)    →  F4 (web SSE registry)
```

- F1 和 F3 互不依赖，可并行
- F2a 依赖 F1 后 typecheck 无 regression
- F4 依赖 F3 后 lark-bot typecheck 无 regression
- 每步完成后跑一次 `bun run test` 确认无回归
