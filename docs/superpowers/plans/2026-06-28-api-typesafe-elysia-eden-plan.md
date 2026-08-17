# 实施 plan：API 类型收敛（Elysia + Eden Treaty）

> 配套 spec：[`2026-06-28-api-typesafe-elysia-eden.md`](../specs/2026-06-28-api-typesafe-elysia-eden.md)
> 基准 HEAD：`8f9e3312`（storage-convergence + zod normalization 已落地，drizzle→$inferSelect 类型链已贯通），所有 `file:line` ±5 行精度
> 本文给函数签名伪代码、路由逐条映射、测试改造清单；产品动线与决策理由见 spec。

---

## 0. 总纲：一条主线、四个阶段

```text
单源 = Elysia app 类型 → api-contract 导出 → web/lark-bot 经 Eden 消费
  PR-1 立骨架（包 + Elysia 并存）→ PR-2 搬路由 + SSE zod codec（删手搓 router）
    → PR-4 web 消费（treaty + react-query hooks 收敛）/ PR-5 lark-bot 消费（并行）
```

### 与 spec 的编号对应

| spec 项 | 本 plan 章节 | PR |
|---|---|---|
| `C1` api-contract 包 | §2 | PR-1 |
| `B1` Elysia 骨架并存 | §3 | PR-1 |
| `B2` auth macro + 路由迁移 | §4 | PR-2 |
| `B3` SSE 保留裸流 | §5 | PR-2/3 |
| `W1` web treaty 化 | §6 | PR-4 |
| `L1` lark-bot treaty 化 | §7 | PR-5 |
| `E1` 其余 e2e 飞地 | §7A | PR-0/4/5 |
| `G1` 防裂化约束文档 | §7A.2 | PR-6 |

---

## 1. 现状盘点（迁移依据，HEAD 核验）

### 1.1 backend HTTP 出口的三层手工结构

- 起服务：`server.ts:9-14` `Bun.serve({ port, hostname, idleTimeout: 0, fetch: (req) => router(req) })`。
- 路由：`http/router.ts`（301 行）单函数 `createRouter(token, features)`，`path.match(正则)` + `method` if 阶梯；测试轻量模式 `:30-41`；顶层 try/catch `:293-299`。
- 鉴权：`http/middleware.ts:3-13` `withAuth(handler, token)`；`infra/auth.ts:1-6` `checkAuth` 用 `crypto.timingSafeEqual`。
- 响应：`http/response.ts` `json`（:4）、`parseJsonBody`（:12）、`sseResponse`（:30-75）。
- 校验：各 `features/*/http.ts` 内 zod，如 `agent/http.ts:39-58` `createSchema`/`updateSchema`。
- 路由数（HEAD 核验）：agents 含 lark-setup ~10、runs/resume 1、conversations 9、ops 12、issues 11、projects 5、column-configs 3、cron 6、health 1。

### 1.2 路由保序的脆弱点（Elysia 迁移后消解）

router.ts 内靠注释手工保序：
- `:190` issue `/events`（SSE）在 `/:id` 前；
- `:199/202/208/211` issue `/:id/transition`、`/deliverables`、`/review-decision`、`/timeline/events`、`/timeline` 在 `/:id` 前；
- `:274` cron `/:id/enable` 在 `/:id` 前。
迁移后由 Elysia radix-tree specificity 保证，注释与人工保序全删。

### 1.3 web API 客户端层

- `api.ts`（611 行，HEAD 核验）手抄 interface：
  - **phase-1 已有**：`ProjectRow` :5-13、`IssueStatus` :16、`IssuePriority` :17、`IssueRow` :18-28、`IssueEventKind` :32-38、`IssueEvent` :41-47、`IssueRunSummary` :49-53、`ColumnConfigRow` :65-81、`LarkConfig` :121-127、`LarkSetupSession` :129-140、`AgentRow` :143-157、`IdentityData` :159-163、`RunMeta` :165-170、`ConversationSnapshot` :180-186。
  - **storage-convergence 后新增**（`~L412-611`，spec 未覆盖、需补删）：`SessionRow` :414-420、`SessionDetail` :422-428、`SessionSpan` :430-437、`RunOpsListItem` :441-455、`RunOpsDetail` :457-485、`AgentRuntimeStatus` :487-500、`SurfaceOpsItem` :502-510、`TraceOpsDetail` :512-523、`CancelRunResult` :525-529、`RecoverRunResult` :531-535、`RunInsights` :539-574、`InsightsSummary` :576-582、`RunDiagnosisKind/DiagnosisOwner/RunDiagnosis` :599-611。
- **实证——手抄 interface 已漂移**（`tsc` 不报错）：
  - run→span 字段名漂移：backend 已 rename `runId`→`spanId`、`parentRunId`→`parentSpanId`，但 web `RunMeta.runId` :166、`RunOpsListItem.runId` :442、`parentRunId` :447、`RunOpsDetail.run.runId` :459 等**仍用旧名**。
  - 死字段残留：backend 已删 `heartbeatAt`/`heartbeatAgeMs`/`transport`/`heartbeatTimeoutMs`/`detached_waiting_reaper`/`heartbeat_fresh_but_transport_detached`，但 web `RunOpsDetail` :471-475、`AgentRuntimeStatus` :490、`CancelRunResult` :528、`RecoverRunResult` :534 **仍保留**。
- `ApiError` :83-91；`apiFetch<T>` :93-117（含 401 跳转 :106-109、204→undefined :115）；`api` 对象 :192-410（~50 函数，含 `apiFetch<AgentRow>` :194 等 54 处泛型调用）。
- BFF：`bff.ts proxyRequest` :60-105（注入 `x-auth-token`+`x-user-id`，删 host，SSE abort 特判 :97-103）；route `app/api/bff/[...path]/route.ts`（`readSession`→401，否则 `proxyRequest`）。
- SSE 消费：`useConversation.ts:65`、`issues/page.tsx:88`、`IssueDetailSheet.tsx:134`（全 `new EventSource`）。
- 服务端直连：`conversations/[id]/page.tsx:6-19`（绕 BFF，`x-auth-token` 首屏 bootstrap）。

### 1.4 lark-bot 出站层

- 6 处 fetch：`bootstrap.ts:60`、`ingest.ts:96/121/165`、`diagnostics.ts:54`、`sse-watcher.ts:86`。
- 4 处 `as` 裸断言：`bootstrap.ts:68`、`ingest.ts:114`、`ingest.ts:185-188`（外加 `event-parser.ts:21` `as Record<string, unknown>` + `render.ts:20` 类型守卫，后两者属 E1-b/E1-c）。
- deps：`lark-bot/package.json` = drizzle-orm + conversation + message + zod（无 backend、无 elysia）。
- 鉴权：`bootstrap.ts:55` `authHeaders(backendAuthToken)`。

### 1.5 依赖图防火墙依据 + backend 内部类型链已贯通

- `apps/backend/package.json` deps 含 `adapter-anthropic`、`drizzle-orm`、`handlebars`、`framework` 等重依赖 → web/lark-bot **不能**直接 `import type` backend。
- 先例：`packages/conversation/package.json` deps 仅 `message`+`zod`，零运行时副作用 → `api-contract` 照此办。
- **backend 内部** drizzle→`$inferSelect`→service 类型链已在 storage-convergence PR 中贯通（`db-typesafe-rules.md` 护栏），本里程碑只动传输层——将 service 返回类型经 Elysia 暴露为 `App` 类型，让 web/lark-bot 可推导。

---

## 2. Phase 1 / `C1` — api-contract 包（PR-1 第一步）

### 2.1 包结构（伪代码）

```jsonc
// packages/api-contract/package.json
{
  "name": "@chengchenccc/api-contract",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["dist"],
  "dependencies": { "elysia": "^1.x" },        // 仅为类型解析
  "devDependencies": { "@chengchenccc/backend": "workspace:*" } // 类型来源，不进运行时
}
```

```ts
// packages/api-contract/src/index.ts
export type { App } from "@chengchenccc/backend/app";
```

- backend `package.json` 加 `"exports": { "./app": "./dist/app.js" }` 以暴露 `App` 类型入口。
- tsconfig composite，只产 `.d.ts`；纳入 turbo build 图（前于 web/lark-bot）。

---

## 3. Phase 1 / `B1` — Elysia 骨架并存（PR-1 第二步）

```ts
// apps/backend/src/app.ts （新建，本 PR 只挂 health）
import { Elysia } from "elysia";
export function createApp(token: string, features: FeatureSet) {
  return new Elysia()
    .get("/health", () => ({ status: "ok" }));
  // 后续 Phase 2 在此 .use(agentRoutes(...)) 等
}
export type App = ReturnType<typeof createApp>;
```

- `server.ts` **不动**（仍 Bun.serve+router）；本阶段 Elysia app 仅供 api-contract 导类型。
- 验收：`treaty<App>().health.get()` 在 web 侧类型通过即可。

---

## 4. Phase 2 / `B2` — auth macro + 路由全迁移（PR-2，主体）

### 4.1 auth macro（复用 checkAuth）

```ts
// infra/auth.ts：checkAuth 重载/新增 header-string 版（timingSafeEqual 体不变）
export function checkAuthToken(header: string, token: string): boolean { /* 同 :1-6 逻辑 */ }

// app.ts
.macro({ auth: (enabled: boolean) => ({
  beforeHandle({ headers, set }) {
    if (!enabled) return;
    if (!checkAuthToken(headers["x-auth-token"] ?? "", token)) {
      set.status = 401; return { error: "Unauthorized" };   // 对齐 middleware.ts:6-9
    }
  },
})})
```

- `/health` 不加 `{ auth: true }`；其余全部 `{ auth: true }`。

### 4.2 逐 feature 路由映射（router.ts 正则 → Elysia）

每个 `features/*/http.ts` 的工厂保持「接 service、返回处理器集合」的形态，但处理器签名从 `(req, ...ids) => Response` 改为 Elysia handler。逐条映射：

```text
agents（router.ts:57-91）:
  GET  /api/agents               → .get("/api/agents", () => svc.list(), { auth })
  POST /api/agents               → .post("/api/agents", ({body}) => svc.create(body), { auth, body: tAgentCreate })
  GET  /api/agents/:id           → .get("/api/agents/:id", ({params}) => svc.getById(params.id), { auth })
  PATCH/DELETE /api/agents/:id   → .patch/.delete(...)
  GET/PUT /api/agents/:id/identity
  POST /api/agents/:id/lark/setup
  GET/DELETE /api/agents/:id/lark/setup/:setupId

runs（router.ts:93-98）:
  POST /api/runs/:id/resume      → .post("/api/runs/:id/resume", ..., { auth, body: tResume })

conversations（router.ts:100-135）: list/create/snapshot/delete/messages/members(POST/DELETE)/events(SSE)/start-new
ops（router.ts:137-171）: sessions/sessions:id/runs/runs:id(+cancel/recover/insights)/insights-summary/agents:id-runtime/traces:id/surfaces/lark-heartbeat
issues（router.ts:173-235）: events(SSE)/issue-meta/list/create/:id-transition/:id-deliverables/:id-review-decision/:id-timeline-events(SSE)/:id-timeline/:id-detail/:id
projects（router.ts:237-252）: list/create/:id(GET/PATCH/DELETE)
column-configs（router.ts:254-266）: list/upsert/:id-DELETE
cron（router.ts:268-291）: :id-enable/list/create/:id(GET/PATCH/DELETE)
```

- zod schema（如 agent/http.ts:39-58）→ 等价 TypeBox `t.Object({...})`，**校验规则一比一**：`z.string().min(1)`→`t.String({minLength:1})`、`z.enum([...])`→`t.Union([t.Literal(...)])`、`.optional()`→`t.Optional(...)`、`z.number().int().positive()`→`t.Integer({minimum:1})`。refine 跨字段校验（larkCreateSchema :15-23）→ Elysia `beforeHandle` 内手校（与现 update handler 路由级校验 http.ts 同位）。
- 返回：`json(row,201)`→`return ({set})=>{set.status=201; return row}`，返回体进类型。

### 4.3 405 / 404 / 错误边界

```ts
.onError(({ code, error, set }) => {
  if (error instanceof HttpError) { set.status = error.status; return { error: error.message }; }
  if (code === "NOT_FOUND") return { error: "Not found" };          // 对齐 router.ts:28
  if (code === "VALIDATION") { set.status = 400; return { error: "Validation failed", details: ... }; }
  set.status = 500; return { error: "Internal server error" };      // 对齐 router.ts:298
})
```

- 现状海量 `405 Method not allowed`（各 feature 块尾）→ 删（Elysia 天然 405）。

### 4.4 server.ts 切换 + 删文件

```ts
// server.ts
const app = createApp(config.authToken, features);
server = app.listen({ port: config.port, hostname: config.host, /* idleTimeout 等价配置 */ });
```

- 删 `http/router.ts`、`http/middleware.ts`；`http/response.ts` 删 `json`/`parseJsonBody`，**留 `sseResponse`**。
- `main.ts` 的 `createRouter(...)` 调用 → `createApp(...)`，FeatureSet 装配不变。

---

## 5. Phase 3 / `B3` — SSE 经 zod codec 收敛（并入 PR-2）

3 条 SSE 路由保留 `EventSource` 消费，但「事件名→载荷」收敛成一张 zod schema map（真源），后端编码器 + 前端解码器都从它推导。

### 5.1 schema-first 前置

```text
LedgerEntry  : 已是 zod（packages/conversation/ledger.ts:19），直接复用
IssueRow     : interface（features/issue/entities.ts:3）→ IssueRowSchema=z.object({...}); type=z.infer  字段一比一
IssueEvent   : TS 类型已从 drizzle $inferSelect 推导（types.ts:16-19，storage-convergence 成果），
               但尚无可用作 SSE 运行时校验的独立 zod schema——需新建 IssueEventSchema=z.object({...})
```

### 5.2 三件套（map / encoder / typedSource）

```ts
// packages/api-contract/src/sse.ts（或挂 packages/conversation）
export const conversationEvents = {
  "message": LedgerEntrySchema, "member.joined": LedgerEntrySchema,
  "member.left": LedgerEntrySchema, "todo": LedgerEntrySchema,
} satisfies SSEEventMap;
export const issueBoardEvents    = { "issue": IssueRowSchema } satisfies SSEEventMap;
export const issueTimelineEvents = { "issue-event": IssueEventSchema } satisfies SSEEventMap;

// 后端：约束 event∈keyof M，data 经 map[event].parse 后再进 sseResponse
function sseEncoder<M extends SSEEventMap>(map: M) {
  return <K extends keyof M>(event: K, data: z.infer<M[K]>) =>
    ({ event: event as string, data: map[event].parse(data) });
}
// features/conversation/http.ts events fn 内：serialize = (entry)=>({id:String(entry.seq), ...enc(entry.kind, entry)})

// 前端：内部仍 new EventSource，重连/readyState 全透出
function typedSource<M extends SSEEventMap>(url: string, map: M) {
  const es = new EventSource(url);
  const on = <K extends keyof M>(name: K, cb: (d: z.infer<M[K]>) => void) =>
    es.addEventListener(name as string, (e) => {
      const r = map[name].safeParse(JSON.parse((e as MessageEvent).data));
      if (r.success) cb(r.data);              // 失败走统一 onError
    });
  return { es, on };                          // es 暴露 onopen/onerror/close
}
```

- `sseResponse`（response.ts:30-75）函数体**零改动**；`: ping` 心跳、`state=done/error` 终态不变。
- Elysia 下这 3 条路由仍在 handler 内直接 `return` 裸 `Response`（`return new Response(stream,...)`），不走 treaty。
- 前端 `useConversation.ts` 现状 4 段重复监听（:107 message、:140 member.joined/left、:159 todo，各自 `JSON.parse`+`safeParseLedgerEntry`）→ 塌缩为 `typedSource(url, conversationEvents)` + 按 map 遍历 `on(...)`。EventSource 实例、`onopen/onerror` 重连逻辑（:71-83）**保留**。

### 5.3 endpoint 注册表：path 与 schema map 同源（杜绝 URL 漂移）

与 §6.4 的 `queryOptions(params)`「params 单一来源」同构：SSE 的 **URL 也不许在组件里手写**（现状 3 处各拼一遍：`useConversation.ts:65`、`issues/page.tsx:88`、`IssueDetailSheet.tsx:134`），否则 path 与 schema map 会随时间各自漂移。把「path 模板 + schema map」绑成一张注册表，URL 由 builder 生成、map 同源取出。

```ts
// packages/api-contract/src/sse.ts —— 端点契约：path 与 events map 绑定，单一来源
export const sseEndpoints = {
  conversationEvents: { path: (p: { id: string }) => `/conversations/${p.id}/events`,        events: conversationEvents },
  issueBoard:         { path: ()                  => `/issues/events`,                        events: issueBoardEvents },
  issueTimeline:      { path: (p: { id: string }) => `/issues/${p.id}/timeline/events`,       events: issueTimelineEvents },
} as const;

// 前端：URL 与 map 从同一条目取，禁止再手写字符串
function openSSE<K extends keyof typeof sseEndpoints>(name: K, params: Parameters<typeof sseEndpoints[K]["path"]>[0]) {
  const ep = sseEndpoints[name];
  return typedSource(`/api/bff${ep.path(params as any)}`, ep.events);   // 经 BFF 两跳，对齐非流式
}
```

- 3 处消费点改为 `openSSE("conversationEvents", { id })` 等，**不再出现裸 URL 模板**；path 改了只动注册表一处，组件零感知。
- 验证：`grep -rn "/events\`\|new EventSource(\`" web/src/{app,components}` 归零（URL 模板只许在 `sseEndpoints` / `typedSource`）。

---

## 6. Phase 4 / `W1` — web Eden Treaty + react-query 收敛（PR-4）

### 6.1 treaty 指向 BFF（保留两跳）

```ts
// web/src/lib/client.ts （新建）
import { treaty } from "@elysiajs/eden";
import type { App } from "@chengchenccc/api-contract";
export const client = treaty<App>("/api/bff", {
  fetch: { credentials: "include" },                  // 对齐 api.ts:97 maw_session
  onResponse: (res) => { if (res.status === 401 && typeof window !== "undefined") location.href = "/login"; }, // 对齐 :106-109
});
```

- BFF `route.ts` / `bff.ts proxyRequest` **不动**：treaty 发 `/api/bff/agents/x` → BFF 透传 path → 后端，落点与现 `apiFetch('agents/x')` 一致。
- web `package.json` + `@elysiajs/eden`、`@chengchenccc/api-contract`。

### 6.2 删手抄类型 + 改调用

- 删 `api.ts` 全部手抄 interface（~15+ 个，见 §1.3 完整清单，含 storage-convergence 后新增的 SessionRow/RunOpsListItem/AgentRuntimeStatus/RunInsights 等）→ 全删。需暴露给组件的类型经 Eden 推导提取（`type AgentRow = NonNullable<Awaited<ReturnType<typeof client.api.agents.get>>["data"]>[number]` 之类，封装到 `client.ts`）。
- **同时消灭的死字段**（backend 已删，web 残留，删手抄 interface 时一并去掉）：`heartbeatAt` :471、`heartbeatAgeMs` :472、`transport` :475、`heartbeatTimeoutMs` :490、`detached_waiting_reaper` :528、`heartbeat_fresh_but_transport_detached` :534。
- **同时纠正的字段名漂移**（traty 自动对齐，不再需要手工 rename）：`runId`→`spanId`、`parentRunId`→`parentSpanId`（11 处）。
- `api` 对象（:192-410）→ 薄封装映射到 `client.api.*`，**命名保持**减小组件改动；泛型来自推导。
- 保留 `ApiError` 语义、401 跳转、204→undefined。
- 验证：`grep -n "apiFetch<" api.ts` 归零；手抄 interface grep 归零；死字段 `heartbeatAt\|heartbeatAgeMs\|transport\|heartbeatTimeoutMs\|detached_waiting_reaper\|heartbeat_fresh_but_transport_detached` grep 归零；`runId\|parentRunId` 仅在 import 自 backend 的真源类型中出现（web 自主命名字段清零）。

### 6.3 SSE 消费 + 服务端直连

- 3 个 `EventSource`（useConversation.ts:65、issues/page.tsx:88、IssueDetailSheet.tsx:134）→ 改用 §5 `typedSource`，EventSource 实例与重连不变，parse/校验收口到 codec。
- `conversations/[id]/page.tsx:6-19` 服务端直连保留（可选改 server 端 treaty 实例，非必须）。

### 6.4 react-query 收敛：queryOptions 绑定 + feature hooks

#### 6.4.1 现状重复（HEAD 核验）

```text
["agents"]        : 9 query + 3 invalidate（AgentForm:103/136/153 等，散落 12 个文件）
["issues"]        : 1 query（issues/page:80）+ 6 invalidate（IssueDetailSheet:171/182/191、IssueKanban:172/187 等）
["conversations",agentId] : 5（ConversationList:15/30/44、NavRail:61/70）
["conv",id]       : 3（useConversation:46、AddMemberButton:63、RosterList:26）
["cron-jobs"]     : cron/page:26、CronJobForm:119/134
["projects"]      : issues/page:96、ProjectList:18、ProjectForm:93/114
["agent",id]      : agents/[id]/page:26、AgentForm:102/152
["column-configs",pid] : ColumnConfigPanel:67/115/128
["identity",aid]  : IdentityPanel:80/87
["ops","insights","summary",range] : 逐字重复 3 图表（CostBreakdownChart:25、TokenTrendChart:21、TopToolsChart:25）
["ops","agentRuntime",..] / ["ops","runs"] / ["ops","sessions",{status}] / ["ops","sessionDetail",id]
  / ["ops","surfaces"] / ["ops","runInsights",runId] : 散落 ops/* 多页
["issue-meta"] issues/page:74; ["issueDetail",id] IssueDetailSheet:119

总计：~92 处 queryKey/queryFn 出现在 ~25 个组件/页面文件中
```

**根因**：不只是 key 散落，是 key 与 queryFn 的请求参数各写一遍——key 放 `id`、请求改 `userId`/`orgId` 不会报错，运行时静默错位。修法：key 与 queryFn 绑进 `queryOptions(params)`，`params` 同源喂两侧。

#### 6.4.2 目录与三件

每 feature 一组（`agents/issues/conversations/cron/projects/column-configs/identity/ops`）：

```text
features/<x>/query-keys.ts   层级化 keys 工厂（all → lists/details → 具体）
features/<x>/queries.ts      queryOptions(params)：queryKey 与 queryFn 同源
features/<x>/mutations.ts     useXxxMutation：invalidate 复用 keys 工厂
features/<x>/hooks.ts         useXxx：仅 useQuery(xxxQuery(params))，组件唯一入口
```

```ts
// features/agents/query-keys.ts
export const agentKeys = {
  all:     ["agents"] as const,
  lists:   () => [...agentKeys.all, "list"] as const,
  list:    (p: AgentListParams) => [...agentKeys.lists(), p] as const,
  details: () => [...agentKeys.all, "detail"] as const,
  detail:  (p: AgentDetailParams) => [...agentKeys.details(), p] as const,
};

// features/agents/queries.ts —— key 与 queryFn 绑定，params 单一来源
export type AgentDetailParams = { id: string };
export function agentDetailQuery(p: AgentDetailParams) {
  return queryOptions({
    queryKey: agentKeys.detail(p),
    queryFn:  () => unwrap(client.api.agents({ id: p.id }).get()),
  });
}

// features/agents/hooks.ts
export function useAgentDetail(p: AgentDetailParams) { return useQuery(agentDetailQuery(p)); }

// features/agents/mutations.ts
export function useUpdateAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AgentUpdate) => unwrap(client.api.agents({ id: input.id }).patch(input)),
    onSuccess: (_d, input) => {
      qc.invalidateQueries({ queryKey: agentKeys.detail({ id: input.id }) });
      qc.invalidateQueries({ queryKey: agentKeys.lists() });   // 按层失效整组
    },
  });
}
// unwrap: treaty {data,error} → 抛 ApiError + 401 跳转（吸收 api.ts:106-109/115 语义）
```

- `loader/prefetch/useQuery` 共用：`queryClient.ensureQueryData(agentDetailQuery(p))`。
- 加 `orgId` 时只改 `AgentDetailParams` + 该 `queryOptions` 一处，组件零感知。
- 3 图表统一 `useInsightsSummary({ range })` → 自动去重；params plain object 由 react-query 稳定 hash（禁放 Date/Map/函数/类实例）。

#### 6.4.3 lint/边界加固

- `queryKey:`/`queryFn:`/`client`（treaty 实例）仅许出现在 `features/*/queries.ts|mutations.ts`（ESLint `no-restricted-syntax` 限定文件 + review 硬规则）。
- 组件文件禁止 `queryKey:`、禁止直调 `client.api.*`，只能调 `hooks.ts` 的 `useXxx`。

#### 6.4.4 验证

- `grep -rn "queryKey:\|queryFn:" web/src/{app,components}` 归零（只许 `features/*/queries.ts|mutations.ts`）。
- `grep -rn "client\.api\." web/src/{app,components}` 归零（组件不直连 treaty）。
- `grep -rn "new EventSource" web/src` 仅 `typedSource` 内一处。
- `grep -rn "process\.env\." web/src` 仅 `config/env.ts` 单源处（PR-0 收敛后）。

---

## 7. Phase 5 / `L1` — lark-bot Eden Treaty 化（PR-5，与 PR-4 并行）

### 7.1 client + deps

```ts
// lark-bot/src/client.ts （新建）
export const makeClient = (backendUrl: string, token: string) =>
  treaty<App>(backendUrl, { headers: { "x-auth-token": token } });   // 无 BFF，直连
```

- `lark-bot/package.json` + `@chengchenccc/api-contract`、`@elysiajs/eden`。

### 7.2 6 处迁移逐条（删 4+1 处 as）

```text
bootstrap.ts:60/68  → const {data,error,status}=await client.api.agents({id}).get();
                      if(status===404) process.exit(0);  // 对齐 :61-64
                      selfAgentName = data.name;          // 删 `as { name; larkEnabled? }` :68
ingest.ts:96/114    → const {data}=await client.api.conversations.post(body); conversationId=data.conversationId; // 删 as :114
ingest.ts:121       → await client.api.conversations({id}).members.post(body);  // !ok 分支→ error 判别
ingest.ts:165/185   → const {data}=await client.api.conversations({id}).messages.post(body);
                      body.seq / body.triggeredRuns 来自推导                    // 删 :185-188 as
diagnostics.ts:54   → await client.api.internal...heartbeat.post(body);
sse-watcher.ts:86   → 保留裸 fetch（流式，对齐 Phase 3）
event-parser.ts:21  → 改 zod schema + safeParse 替 `as Record<string,unknown>` + 手 narrow（E1-c，并入 PR-5）
```

- 所有 `!resp.ok`/`resp.status` 业务分支语义不变，仅判别方式从 `resp.ok` 改为 treaty `{ data, error }`。
- 验证：`grep -rn "as {" lark-bot/src/{bootstrap,ingest,diagnostics,event-parser}.ts` 归零。

---

## 7A. Phase 6 / `E1`+`G1` — 其余 e2e 漂移飞地 + 防裂化约束

### 7A.1 四块跨进程飞地收敛（`E1`，HEAD 核验）

```text
env 单源（E1-a，PR-0）:
  现状 backend BACKEND_AUTH_TOKEN（config.ts:28）/ lark-bot BACKEND_AUTH_TOKEN（args.ts:32）
       / web BFF BACKEND_TOKEN（bff.ts:8）/ web page BACKEND_TOKEN（conversations/[id]/page.tsx:7）
       ——同一后端密钥跨进程两个名字，四进程各裸读 process.env
  改法 抽共享 zod envSchema + parseEnv()；四进程统一调用，命名归一（BACKEND_TOKEN→BACKEND_AUTH_TOKEN），启动 fail-fast

lark content 单源（E1-b，并入 PR-5）:
  现状 lark-bot 写 content={text,source,larkEventId,larkMessageId}（ingest.ts:171-176）
       → backend content: z.unknown()（conversation/http.ts:37），内层零校验
  改法 content 形状提共享 zod（api-contract 或 @chengchenccc/message），两端 import；backend 替 z.unknown()

lark event 单源（E1-c，并入 PR-5）:
  现状 LarkMessageEvent 手写 interface（event-parser.ts:3-17）+ JSON.parse as Record<string,unknown> :21 + 逐字段手 narrow :23-42
  改法 改 zod schema，parseEvent 用 safeParse 替手写 narrow

IssueStatus 单源（E1-d，并入 PR-4）:
  现状 backend entities.ts:20 与 web api.ts:16 各抄五值联合 + 多处 as IssueStatus 强转
  改法 枚举挪共享包（z.enum/as const），两端 import；消除 web 副本与 as 强转
```

- DB JSON 列（`deliverable/adapter-sqlite.ts:13` 等 `JSON.parse as T`）、handlebars 模板变量（`render.ts:13` `Record<string,unknown>`）**列为延后债**（与 storage/模板真源同源，本里程碑不展开）。

### 7A.2 防裂化约束文档（`G1`，PR-6）

新建两份约束文档，覆盖 backend 内部 + 跨进程全链：

**a) `docs/architecture/e2e-contract-rules.md`**——铁律 1 在传输/跨进程层的可执行版：
```text
§1 触发器决策表   当你要做 X → 先去 Y 取真源 → 禁止 Z（if-then，非泛原则）
§2 真源地图       每类契约：真源文件 / 消费方式 / 反模式 一张表
§3 grep 自检      每类裂化配一条 grep，非零返回=裂化（替代「tsc 过了就行」假信号）
§4 自问三连       未覆盖的新情况按第一性外推
```

**b) `docs/architecture/db-typesafe-rules.md`**——铁律 1 在 backend 内部类型链（drizzle→$inferSelect→service→http）的可执行版：
```text
§1 触发器决策表   加列/读行/写行/JSON列/int bool/枚举 → 取真源 → 禁止手写
§2 真源地图       drizzle 表 / $inferSelect / $inferInsert / drizzle-zod / JSON codec / int bool codec
§3 grep 自检      手写 interface / JSON.parse as / 裸断 row 类型 / 重抄枚举
§4 自问三连       属于哪个表 / 真源是 Select 还是 Insert / 有 JSON/int bool 列吗 / 改表会标红吗
§5 层级图         schema.ts → types.ts → service.ts → http.ts（单向流动）
§6 边界           与 e2e-contract-rules 互补：内部 vs 跨进程
```

- `CLAUDE.md` Design Philosophy 段同步加两份指针（每次必读 → 激活整张表入口）。
- 决策：约束文档是里程碑**交付项**而非可选——收敛是一次性的、裂化是持续的，没有动手时刻能激活的护栏，新代码会按局部最省力路径重新裂化。

---

## 8. 施工顺序与依赖

```text
PR-0  Phase 6a env 单源 envSchema + parseEnv（E1-a）              ← 零行为变更，独立可发，最先落
PR-1  Phase 1  api-contract 包 + Elysia 骨架并存（C1+B1）       ← 零行为变更，独立可发
PR-2  Phase 2+3  auth macro + 路由全迁 + SSE zod codec + 删 router/middleware（B2+B3） ← 依赖 PR-1
PR-4  Phase 4  web treaty 化 + 删手抄 interface(含死字段/漂移字段) + react-query 收敛 + IssueStatus 共享枚举（W1+E1-d） ← 依赖 PR-2
PR-5  Phase 5  lark-bot treaty 化 + 灭 as + lark content/event 共享 zod（L1+E1-b+E1-c） ← 依赖 PR-2，与 PR-4 并行
PR-6  Phase 6b 防裂化约束文档（e2e-contract-rules + db-typesafe-rules）+ CLAUDE.md 指针（G1） ← PR-2~5 落地后收尾
```

**强链**：PR-0 独立；PR-1 → PR-2 →（PR-4 / PR-5 并行）→ PR-6 收尾。

---

## 9. 测试改造的横切原则

1. **路由迁移同 PR 改对应 `*.test.ts`**：`http.test.ts`（各 feature）从「构造 Request 喂 router」改为「`app.handle(new Request(...))`」或 Eden `treaty(app)` 内存调用——后者顺带验证类型。
2. **auth 回归**：保留「缺 x-auth-token → 401」「错 token → 401」「/health 免鉴权」用例，断言不变。
3. **route-ordering 回归**：保留「`/api/issues/events` 不被 `/:id` 吞」「`/api/cron-jobs/:id/enable` 不被 `/:id` 吞」用例（现靠注释，迁移后靠 Elysia，仍需测试守住）。
4. **校验等价**：每个 zod→TypeBox 转换配一条「非法 body → 400」用例，确保 minLength/enum/optional 语义一致。
5. **SSE 回归 + codec**：保留「events 端点返回 `text/event-stream`、含 `: ping`、终态 `state=done`」断言（sseResponse 不动）。新增「`IssueRowSchema`/`IssueEventSchema`/`LedgerEntrySchema` 经 `SSEEventMap` 校验：合法载荷 round-trip、非法载荷被 `safeParse` 拒」单测；前端 `typedSource` 「事件名拼错 → tsc 失败」类型守卫；新增「`sseEndpoints` path builder 与后端 Elysia 路由 path 一致」用例（守住 URL 单源不与实际路由漂移）。
6. **删除类 grep 归零硬指标**：PR-2 落地以 `grep -rn "withAuth\|createRouter" apps/backend/src` 归零（除删除文件）；PR-4 以 `grep "apiFetch<" web/src/lib/api.ts` 归零、`grep -rn "queryKey:\|queryFn:" web/src/{app,components}` 归零（只许 `features/*/queries.ts|mutations.ts`）、`grep -rn "client\.api\." web/src/{app,components}` 归零（组件不直连 treaty，只调 `useXxx`）、`grep -rn "new EventSource" web/src` 仅 `typedSource` 内一处、`grep -rn "heartbeatAt\|heartbeatAgeMs\|transport\|heartbeatTimeoutMs\|detached_waiting_reaper\|heartbeat_fresh_but_transport_detached" web/src` 归零（死字段清零）、`grep -rn "runId\|parentRunId" web/src` 仅命中从 backend 真源 import 的类型（web 自主命名字段清零）；PR-5 以 `grep "as {" lark-bot/src/{bootstrap,ingest,diagnostics,event-parser}.ts` 归零。
7. **端到端类型联动测试**：新增一条「改 backend 返回字段 → web/lark-bot tsc 失败」的负向类型测试（可用 `tsd` 或 `// @ts-expect-error` 守卫），证明真源生效。
8. **react-query hooks 回归**：每个自定义 hook 配一条用例（mock treaty client）验证 queryKey 由 `queryOptions(params)` 内的 keys 工厂生成（key 与 queryFn 同源、params 单一来源）、mutation onSuccess 触发正确的 `invalidateQueries`（按层失效复用 keys 工厂）；重点守住「3 图表共用 `useInsightsSummary({ range })` → 同 key 缓存命中只发一次请求」。
9. **其余 e2e 飞地回归（`E1`）**：env 单源——「缺失/拼错 env → `parseEnv()` 启动 throw（fail-fast）」用例 + `grep -rn "process\.env\." apps/{backend,web,lark-bot}/src` 仅命中 env 单源处；lark `content`——共享 zod 「合法 round-trip / 改字段名两端 tsc 报错」；lark event——`parseEvent` 用 `safeParse`「合法事件解析 / 缺字段被拒」替手写 narrow 用例；`IssueStatus`——backend 加一个 status 值 → web 端穷尽分支处 tsc 报错（共享枚举生效的负向类型测试）。
10. **防裂化约束文档（`G1`）**：`docs/architecture/e2e-contract-rules.md` 存在且含 §1~§4 四节；`docs/architecture/db-typesafe-rules.md` 存在且含 §1~§6 六节；`CLAUDE.md` Design Philosophy 段含两份指针；两份规则的 §3 grep 自检块可直接跑（CI 可选择把这几条 grep 接入，非零即失败）。

---

## 10. 验收总清单

生产代码（同 spec §9）：
- [ ] `packages/api-contract` 零运行时依赖，`export type { App }`；backend `exports["./app"]` 暴露类型。
- [ ] backend 经 Elysia 起服务；`http/router.ts`、`http/middleware.ts` 删；`http/response.ts` 仅留 `sseResponse`。
- [ ] auth 经 macro 复用 `checkAuth`（timingSafeEqual）；/health 豁免；401 行为不变。
- [ ] 所有 zod 校验等价迁 TypeBox，规则一比一。
- [ ] 405 样板删除（Elysia 天然 405）；404/500/HttpError 错误边界等价。
- [ ] SSE 3 端点在 Elysia 下保留裸 `sseResponse`；`IssueRow`/`IssueEvent` schema-first；`SSEEventMap` zod 单源喂 `sseEncoder`+`typedSource`；`sseEndpoints` 注册表绑 path+map，组件不再手写 URL；前端 EventSource 重连零回归。
- [ ] web：`api.ts` 手抄 interface 清零（含 storage-convergence 后新增的 SessionRow/RunOpsListItem/AgentRuntimeStatus/RunInsights 等）、`apiFetch<>` 泛型清零、死字段（heartbeat*/transport/detached_waiting_reaper 等）清零、run→span 字段名漂移纠正（`runId`→`spanId`/`parentRunId`→`parentSpanId`），改 treaty 推导；组件内 `queryKey:`/`queryFn:`/`client.api.*` 全清零（收敛到 `features/*/queries.ts|mutations.ts`，key 与 queryFn 绑进 `queryOptions(params)`、params 单一来源）；每 feature `query-keys/queries/mutations/hooks` 四件就位，组件唯一入口为 `useXxx`，页面不再内联 useQuery/invalidate；BFF 两跳保留（cookie→token + x-user-id + 401 跳转不变）。
- [ ] lark-bot：6 处 fetch 迁 treaty（sse-watcher 流式除外），4 处 `as` + event-parser `as Record` 清零。

其余 e2e 飞地收敛 + 防裂化（`E1`+`G1`，同 spec §9）：
- [ ] env：三进程经共享 `envSchema`+`parseEnv()`，`BACKEND_TOKEN`→`BACKEND_AUTH_TOKEN` 命名归一，`grep -rn "process\.env\." apps/{backend,web,lark-bot}/src` 仅命中 env 单源处。
- [ ] lark `content`：共享 zod 约束，backend 替掉 `content: z.unknown()`；改字段名两端 tsc 报错。
- [ ] lark event：`LarkMessageEvent` 改 zod + `safeParse`，`event-parser.ts` 无手写 `as Record<…>` narrow。
- [ ] `IssueStatus`：单一定义源（共享包），web 本地副本与 `as IssueStatus` 强转清零。
- [ ] 新增 `docs/architecture/e2e-contract-rules.md`（§1~§4）；新增 `docs/architecture/db-typesafe-rules.md`（§1~§6）；`CLAUDE.md` Design Philosophy 段加两份指针。

测试（本 plan 新增/改动）：
- [ ] 各 feature `http.test.ts` 改用 `app.handle`/treaty 内存调用；auth、route-ordering、zod→TypeBox 校验、SSE 回归用例全绿。
- [ ] SSE codec 单测：`SSEEventMap` 合法 round-trip / 非法 `safeParse` 拒；`typedSource` 事件名类型守卫；`sseEndpoints` path 与路由一致性。
- [ ] react-query hooks 单测：queryKey 由 `queryOptions(params)` 内 keys 工厂生成（key 与 queryFn 同源）、mutation invalidate 按层复用 keys 工厂、3 图表共 key 去重。
- [ ] 新增端到端类型联动负向测试（改字段 → 下游 tsc 失败）。
- [ ] grep 归零硬指标：`withAuth/createRouter`、`apiFetch<`、组件内 `queryKey:`/`queryFn:`/`client.api.`、死字段（heartbeat*/transport/lark 变体）、run→span 漂移字段、lark-bot `as {`、手写 `as Record` 全清零。
- [ ] `E1`/`G1` 回归：env fail-fast 用例 + `process.env.` grep 收口；lark `content`/event 共享 zod round-trip + 改字段下游 tsc 报错；`IssueStatus` 共享枚举负向类型测试；两份约束文档存在且章节齐全、CLAUDE.md 指针在位。

---

## 11. 关联

- 配套 spec [`2026-06-28-api-typesafe-elysia-eden.md`](../specs/2026-06-28-api-typesafe-elysia-eden.md)
- 上一轮 plan [`2026-06-27-storage-convergence-plan.md`](./2026-06-27-storage-convergence-plan.md) —— 存储真源收敛（本 plan 收敛传输契约真源）
- 防裂化规则 [`e2e-contract-rules.md`](../../architecture/e2e-contract-rules.md)（跨进程层）、[`db-typesafe-rules.md`](../../architecture/db-typesafe-rules.md)（backend 内部类型链）
- 上游 [Elysia 端到端类型](https://elysiajs.com/eden/overview)、[Eden Treaty Response](https://elysiajs.com/eden/treaty/response)
- 零依赖契约包先例 `packages/conversation`、`packages/message`
