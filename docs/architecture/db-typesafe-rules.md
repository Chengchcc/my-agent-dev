# Backend 内部类型链防裂化规则（drizzle → service）

> 本文是 **design-philosophy 铁律 1「统一本体，不复制语义」在 backend 内部类型链上的可执行版**。
> 任何 agent（或人）在 backend 内加字段、改表结构、写 service 返回类型、读写 JSON 列、加枚举值前，**先过这张表**。
> drizzle schema 在 `apps/backend/src/infra/db/schema.ts` 是**唯一真源**：所有 TS 类型、zod schema、service DTO 都从它单向推导。

## 0. 一句话根因

drizzle 表定义一旦和 service 层的类型**各写一份**，编译器就看不见它们的关系：改表加字段、service 手写 interface 不报错；删列、service 残留死字段。`tsc 通过` 不是"对"的证据（手写 interface 和 drizzle 表可以永久分叉）。**唯一解法：drizzle 表是唯一真源，所有下游类型经 `$inferSelect`/`$inferInsert` + drizzle-zod 推导。**

> 实证（2026-06-28 HEAD）：backend 已完成的 storage-convergence 把 `runId`→`spanId`、删掉了 `heartbeatAt`/`transport`，但 web 的 `api.ts` 手抄 interface 仍用旧名、仍保留死字段，`tsc` 全程不报错。backend 内部的 drizzle→service 链已收敛，但若不加规则护栏，同样裂化会在 6 个月后重现。

## 1. 触发器决策表（动手前必查）

| 当你要…… | 先停，去这里取真源 | 禁止 |
|---|---|---|
| 给表加一个列 | 改 `schema.ts` 的 drizzle 表定义，生成 migration；类型从 `$inferSelect` 自动流到所有消费者 | 先改 service 层的 interface，再"回头同步"表定义 |
| 读一个 DB 行 | `import { xxxSelectSchema } from "../../infra/db/schema.js"` → `.parse(row)`；类型用 `typeof schema.xxx.$inferSelect` | `row as XxxRow` / 手写 `interface XxxRow { ... }` |
| 写一个 DB 行 | `import { xxxInsertSchema }` → `.parse(input)` 校验后才写入；类型用 `typeof schema.xxx.$inferInsert` | 裸 `db.insert(xxx).values(input)` 无校验 |
| 在 service 层定义返回类型 | 从 `$inferSelect` 推导：`type MyDto = Pick<...$inferSelect, "a" | "b">` 或 `Omit<...$inferSelect, "internal">` | 手写 `export interface MyDto { a: string; b: number }` |
| 在 HTTP handler 返回 JSON | 返回体形状由 service 返回类型决定（service 类型从 `$inferSelect` 来） | 在 handler 里即兴拼对象返回 |
| 读写一个 JSON 列（payload/fields/metadata/config） | 在 `schema.ts` 的 drizzle-zod 中写双向 transform：`(s) => s.transform(JSON.parse)` 读 / `(s) => s.transform(JSON.stringify)` 写 | 业务代码里 `JSON.parse(row.payload) as T` |
| 读写一个 int bool 列（enabled/autoOrchestrate） | 在 `schema.ts` 的 drizzle-zod 中写 transform：`(s) => s.transform(n => n !== 0)` 读 / `(s) => s.transform(b => b ? 1 : 0)` 写 | 业务代码里 `!!row.enabled` / `row.enabled ? 1 : 0` |
| 加一个枚举/状态值 | 在共享位置定义 `as const` / `z.enum`，两端 `import` | 在新文件重抄一遍联合类型；`as SomeStatus` 裸断 |
| 改一个列的类型 | 只改 `schema.ts` 的 drizzle 列定义 → `typecheck` 自动标红所有下游断裂点 | 改了表、手动追着改各层类型 |

## 2. 真源地图

| 契约类 | 单一真源 | 消费方式 | 反模式（=裂化） |
|---|---|---|---|
| 表形状（列名/类型/约束） | `schema.ts` 的 `sqliteTable(...)` 定义 | drizzle-kit generate → migration | 手写 CREATE TABLE SQL |
| Row 读类型 | `typeof schema.xxx.$inferSelect` | `import type` → `Pick`/`Omit`/直接使用 | 手写 `interface XxxRow { ... }` |
| Row 写类型 | `typeof schema.xxx.$inferInsert` | `import type` → 直接使用 | 手写 `interface XxxInsert { ... }` / 裸 `Record<string, unknown>` |
| 运行时校验（读） | `xxxSelectSchema`（drizzle-zod `createSelectSchema` + transform） | `.parse(row)` → 类型收窄为 `$inferSelect` | `row as XxxRow` |
| 运行时校验（写） | `xxxInsertSchema`（drizzle-zod `createInsertSchema` + transform） | `.parse(input)` → 类型收窄为 `$inferInsert` | 裸 insert 无校验 |
| JSON 列 codec | drizzle-zod `refine` callback：读 `JSON.parse`、写 `JSON.stringify` | 对业务代码透明：经 zod parse 后自动是 object | `JSON.parse(row.payload) as T` |
| Int bool codec | drizzle-zod transform：读 `n !== 0`、写 `? 1 : 0` | 对业务代码透明：经 zod parse 后自动是 boolean | `!!row.enabled` / 手动 `? 1 : 0` |
| Service DTO 类型 | `$inferSelect` → `Pick`/`Omit`/`& { override }` | `export type FooDto = Pick<typeof schema.foo.$inferSelect, "a" | "b">` | 手写 `export interface FooDto { a: string; b: number }` |
| 枚举/状态值 | 共享 `as const` 或 `z.enum`（位置：`types.ts` 或 feature 的 `entities.ts`） | `import { ISSUE_STATUSES }` / `z.enum([...])` | 各处重抄字面量联合 |
| 迁移 | drizzle-kit generate 产出 `.sql` 文件 | `bun run db:gen`（或手动写 migration SQL） | 手动改 DB 不产 migration |

## 3. 写完自检（grep 非零 = 裂化，须修）

```bash
# 业务代码不得手写 drizzle 表已有字段的 interface
grep -rn "interface.*Row\b" apps/backend/src/features/ | grep -v entities.ts
# 业务代码不得裸 JSON.parse + as（JSON 列应经 drizzle-zod parse）
grep -rn 'JSON.parse(.*) as [A-Z]' apps/backend/src/features/
# 业务代码不得裸断 row 类型
grep -rn ' as [A-Z][a-z]*Row\b' apps/backend/src/features/
# 枚举不得在各 feature 重抄字面量（应 import 共享源）
grep -rn 'type.*Status.*=.*".*".*".*"' apps/backend/src/features/
# int bool 不得在业务代码手动转换
grep -rn '!!.*\.enabled\|!!.*\.autoOrchestrate\|.*enabled.*? 1 : 0\|.*enabled.*? 0 : 1' apps/backend/src/features/
```

每条命中都要回答：这个类型的真源是不是 `schema.ts` 的 drizzle 表？为什么这里没从 `$inferSelect`/drizzle-zod 推导？答不上来就是新裂化点。

## 4. 加新表/新列时的自问（外推用）

在 `schema.ts` 之外引入任何**会被另一个 feature / service / HTTP handler 读到**的类型、字段前，先问：

1. 它属于哪个已有 drizzle 表？如果属于已有表 → 改表定义，类型自动流下去。如果不属于 → 建新表。
2. 它的**真源**是 `$inferSelect` 还是 `$inferInsert`？service 读路径用 Select，写路径用 Insert。
3. 它有 JSON 列吗？有 → 必须在 `schema.ts` 的 drizzle-zod 里加 transform。写代码的人不应在业务层再 `JSON.parse`。
4. 它有 int bool 列吗？有 → 必须在 `schema.ts` 的 drizzle-zod 里加 transform。写代码的人不应在业务层再 `!!` / 三元。
5. 如果半年后有人改了表结构（加列/删列/改名），编译器会拦住所有下游断裂点吗？拦不住，就还没收敛好。

## 5. 层级图（数据流向，单向）

```text
┌─────────────────────────────────────────────────────────┐
│  schema.ts                                              │
│  sqliteTable("xxx", { ... })   ← 唯一真源               │
│  createSelectSchema(xxx, { ... })  ← JSON/int bool 在这 │
│  createInsertSchema(xxx, { ... })                       │
│  $inferSelect / $inferInsert    ← TS 类型自动产出       │
└────────────┬────────────────────────────────────────────┘
             │ import type / import schema
             ▼
┌─────────────────────────────────────────────────────────┐
│  types.ts (feature 级)                                  │
│  export type FooRow = typeof schema.foo.$inferSelect    │
│  export type FooInsert = typeof schema.foo.$inferInsert │
│  (有 JSON 列的用 Omit + & 覆写 transform 后的类型)      │
│  export type FooEvent = Omit<...$inferSelect, "col"> &  │
│    { col: ParsedType }                                  │
└────────────┬────────────────────────────────────────────┘
             │ import type
             ▼
┌─────────────────────────────────────────────────────────┐
│  service.ts / store.ts                                  │
│  返回类型从 types.ts 的 $inferSelect 类型 Pick/Omit     │
│  运行时校验：schema.xxxSelectSchema.parse(row)          │
│  写入校验：schema.xxxInsertSchema.parse(input)          │
└────────────┬────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────┐
│  http.ts                                                │
│  handler 返回类型 = service 返回类型（从 $inferSelect    │
│  全链推导，不经手写）                                    │
└─────────────────────────────────────────────────────────┘
```

**铁律**：数据只在一个方向流动：`schema.ts → types.ts → service.ts → http.ts`。反向依赖（service 定义类型让 schema 适配）视为架构违规。

## 6. 与跨进程规则的边界

| 层面 | 规则文档 | 真源 |
|---|---|---|
| Backend **内部**类型链（drizzle → $inferSelect → service → http） | 本文 | `schema.ts` drizzle 表 |
| Backend ↔ web ↔ lark-bot **跨进程**类型链（HTTP/SSE/env） | [`e2e-contract-rules.md`](./e2e-contract-rules.md) | Elysia `App` 类型（`export type App = typeof app`） |

两层规则互补、不重叠。backend 内部改了表 → service 类型自动流到 http handler → http handler 返回体进 `App` 类型 → web/lark-bot 经 treaty 自动感知。**两套真源打通后，改一个 drizzle 列，全链 tsc 标红**：从 DB 列到前端组件的端到端类型安全。

> 关联：[`design-philosophy.md`](./design-philosophy.md)（why）、[`e2e-contract-rules.md`](./e2e-contract-rules.md)（跨进程层）、[`2026-06-28-api-typesafe-elysia-eden.md`](../superpowers/specs/2026-06-28-api-typesafe-elysia-eden.md)（传输层落地 spec）。
