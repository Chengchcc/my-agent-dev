# 端到端契约规则（防类型裂化）

> 本文是 **design-philosophy 铁律 1「统一本体，不复制语义」在传输/跨进程层的可执行版**。
> 任何 agent（或人）在 backend / web / lark-bot 之间加字段、调接口、消费 SSE、加查询、读环境变量、跨进程传结构前，**先过这张表**。
> 部分真源（`api-contract` 包、`SSEEventMap`、共享 `envSchema`）随 milestone `2026-06-28-api-typesafe-elysia-eden` 落地；落地前按目标态写新代码，不要再加裂化副本。

## 0. 一句话根因

跨进程/跨包的契约一旦**两端各写一份**，编译器就看不见它们的关系：改一边、另一边静默错位，`tsc` 不报错、`as` 把窟窿焊死。**唯一解法：每类契约只有一个真源，两端都从它推导。** `tsc 通过` 不是"对"的证据。

## 1. 触发器决策表（动手前必查）

| 当你要…… | 先停，去这里取真源 | 禁止 |
|---|---|---|
| 在 web 用一个后端返回的字段 | 改 backend 返回类型，让它经 `App` 流过来；web 从 treaty 推导 | 在 web 手写/扩一个 `interface` 接住它 |
| 调一个后端接口 | `client.api.*`（`treaty<App>`，类型来自 `@chengchenccc/api-contract`） | `apiFetch<T>` / 裸 `fetch` + `as T` |
| 消费一个 SSE 事件 | 在 `SSEEventMap` 加/取该事件的 zod schema，用 `typedSource(url, map)` | `new EventSource` + 各自 `JSON.parse` + `as` |
| 拼一个 SSE 端点 URL | `sseEndpoints` 注册表 + `openSSE(name, params)` | 组件里手写 `/.../events` 模板字符串 |
| 加一个 `useQuery` / `useMutation` | `features/<x>/queries.ts` 写 `queryOptions(params)`，组件只调 `useXxx` | 组件内联 `queryKey:` / `queryFn:`；key 与请求参数分开写 |
| 读一个环境变量 | 共享 `envSchema`，调 `parseEnv()` | 各进程裸 `process.env.XXX` |
| 跨进程传一个结构（lark↔backend 的 `content`、webhook event、队列消息） | 提一个共享 zod schema，两端 `import` + `parse`/`safeParse` | 一端写 `interface`、另一端 `as {…}` / `as Record<…>` |
| 加一个状态值 / 枚举值（如 run state） | 改共享枚举单源（`as const` / `z.enum`），两端 `import` | 在新文件重抄一遍联合类型；`as SomeStatus` 强转 string |
| 读写一个 DB JSON 列（metadata/config/payload/fields） | 给该列定义 zod 双向 codec，写 `serialize`、读 `parse` | `JSON.parse(row.x) as T` |
| 渲染一个模板（handlebars） | 给 `PromptVars` 固定类型，键与模板变量同源校验 | `Record<string, unknown>` + 字符串约定 |

## 2. 目标态真源地图

| 契约类 | 单一真源 | 消费方式 | 反模式（=裂化） |
|---|---|---|---|
| HTTP 请求/响应 | backend Elysia `App` → re-export 自 `@chengchenccc/api-contract` | `treaty<App>()` 推导 | 手抄 `XxxRow` interface、`apiFetch<T>`、响应 `as` |
| SSE 事件载荷 | `SSEEventMap`（值为 zod schema，`api-contract/src/sse.ts`） | 后端 `sseEncoder<M>`、前端 `typedSource<M>` | 后端裸 `event` 字符串、前端各自 `JSON.parse`+`safeParse`/`as` |
| SSE 端点 URL | `sseEndpoints` 注册表（path 模板 + events map 绑定） | `openSSE(name, params)` | 组件手写 URL 模板，与 map 各自漂移 |
| react-query key/param | `queryOptions(params)`（`features/<x>/queries.ts`），`params` 为 key 与请求参数唯一来源 | `useXxx` hook（组件唯一入口） | 组件内联 `queryKey`/`queryFn`；key 写 id、queryFn 改 userId 静默错位 |
| 环境变量 | 共享 `envSchema`（落点随里程碑定，建议独立 `config` 包） | `parseEnv()` 一处解析 | 三进程各裸读、变量名两端不一致（现状 `BACKEND_AUTH_TOKEN` vs `BACKEND_TOKEN`） |
| 跨进程消息（lark `content`、webhook event） | 共享 zod schema | 两端 `import` + `parse`/`safeParse` | 一端 interface、另一端 `as`；backend 收成 `z.unknown()` |
| 枚举 / 状态 | 共享 `as const` / `z.enum` | 两端 `import` | 各处重抄字面量；`as Status` |
| DB JSON 列 | zod 双向 codec | `parse` 读 / `serialize` 写 | `JSON.parse(...) as T` |
| Oma stdio JSONL 协议 | `apps/oh-my-agent` 生成的 canonical fixture（`rpc-*.jsonl`） | `packages/adapter-oma-agent` 测试消费 fixture | 共享 wire-schema 包；或两端各写 schema 且无 fixture |
| 模板变量 | 固定 `PromptVars` 类型 | 类型约束 + 文档化变量表 | `Record<string, unknown>` + `strict:false` 静默空串 |

## 3. 写完自检（grep 非零 = 裂化，须修）

```bash
# 组件不得手抄类型 / 直连 fetch
grep -rn "apiFetch<\|as AgentRow" apps/web/src
# 组件不得内联 query 或直调 treaty（只许出现在 features/*/queries.ts|mutations.ts）
grep -rn "queryKey:\|queryFn:\|client\.api\." apps/web/src/{app,components}
# SSE 只许在 typedSource 内 new EventSource；URL 只许在 sseEndpoints
grep -rn "new EventSource\|\`.*\/events\`" apps/web/src
# 环境变量只许在 envSchema/parseEnv 出现
grep -rn "process\.env\." apps/{backend,web,lark-bot}/src
# 跨进程不得裸断言
grep -rn "as {\|as Record<" apps/lark-bot/src
```

每条命中都要回答：这个契约的真源是谁？为什么这里没从真源推导？答不上来就是新裂化点。

## 4. 加新契约时的自问（外推用）

引入任何**会被另一个进程/包读到**的类型、字段、事件、枚举、环境变量、JSON 形状之前，先问：

1. 它属于哪个已有领域对象？（铁律 1）
2. 它的**真源**应该放在哪个包？两端怎么从真源推导，而不是各写一份？
3. 如果半年后有人只改其中一端，编译器会拦住他吗？拦不住，就还没收敛好。

> 关联：[`design-philosophy.md`](./design-philosophy.md)（why）、milestone spec [`2026-06-28-api-typesafe-elysia-eden`](../superpowers/specs/2026-06-28-api-typesafe-elysia-eden.md)（how，本规则的落地）。
