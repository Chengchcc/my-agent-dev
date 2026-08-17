# ADR 0010: Typed Context Keys — 引擎单态化，per-run 数据靠键类型收窄

> ⚠ **已过期(2026-08-13)**:未采纳——typed context keys 未落地,引擎已按 ADR 0016 整体重建(run-centric),本提案的对象(HookContext/单态化)不再存在。

## 状态

Superseded(was Proposed,未采纳)

## 上下文

ADR 0009 补充决策 D 明确规定：`HookContext` 上的 per-run 业务上下文字段应为 **`context?: unknown`**（把原来的业务名 `conversation` 改成技术中性名 `context`），plugin 在运行时自己 `as` 收窄。这是一个**单态**（monomorphic）设计——framework 引擎不带任何类型参数，per-run 数据是一个 opaque 槽。

但 commit `93122efb`（塌缩 harness 调用层的落地实现）**偏离了这条已 Accepted 的决策**，改成了泛型方案：

- `HookContext<Ctx = Record<string, unknown>>`，字段是 `data?: Ctx`（不是 `context?: unknown`）
- 泛型 `Ctx` 一路穿过 `PluginHooks<Ctx>` / `Plugin<Ctx>` / `AgentConfig<Ctx>` / `AgentRunOptions<Ctx>` / `Agent<Ctx>` / `PluginRunner<Ctx>` / `AgentRuntime<Ctx>` / `createAgent<Ctx>` / `AgentSession<Ctx>`
- `AgentSession.setData(value: Ctx)` 替代了 ADR 0009 设想的 keyed `setContext`

这个泛型是**无约束**的（`Ctx = Record<string, unknown>` 只是默认值，不是 `extends` 约束），于是引擎里凡是消费 `AgentRuntime<Ctx>` 的地方都被迫要么同步泛型化、要么退化到默认值。落地时 `spanLoop(rt: AgentRuntime, opts)`（`span-loop.ts:46`）**没有**跟着泛型化，默认成了 `AgentRuntime<Record<string, unknown>>`。结果：

```
create-agent.ts(196,41): error TS2345: Argument of type 'AgentRuntime<Ctx>'
  is not assignable to parameter of type 'AgentRuntime<Record<string, unknown>>'.
create-agent.ts(243,41): 同上
create-agent.ts(302,41): 同上
```

根因是 `PluginRunner<Ctx>` 里的 `readonly _ctx?: Ctx` 幻影字段——它让 `AgentRuntime<Ctx>` 对 `Ctx` **不变**（invariant）。`AgentRuntime<Ctx>`（未约束 `Ctx`）无法赋给 `AgentRuntime<Record<string, unknown>>`，三个 `spanLoop(rt, ...)` 调用点全部 TS2345。

### 影响面

`bun test`（Bun 不做类型检查）在 framework 包内是 137 pass / 0 fail，所以问题在运行时不可见。但 `bun run typecheck`（tsc）失败：

- framework 编译失败 → 依赖 `@chengchenccc/framework` 的 8 个包全部 `^build` 失败 → turbo 的 `typecheck` / `test`（都 `dependsOn: ["^build"]`）整条流水线红。
- collapse-harness spec 的验收标准 `bun run typecheck # 0 errors` + `bun run test # 340 pass / 0 fail` 因此**从未真正通过**。

### 泛型方案的结构性问题（不止这一个编译错）

即便把 `spanLoop` 也泛型化把这次编译错压下去，泛型方案本身仍有三个固有缺陷：

1. **单槽 blob**：`data?: Ctx` 整个 run 只有一个类型槽。两个插件想各自携带自己的 per-run 数据时，只能挤进同一个 `Ctx`，退化成 `Record<string, unknown>` 大杂烩。
2. **类型参数横穿引擎**：`Ctx` 是一条穿过 framework/harness **每一层**的轴。任何消费 `AgentRuntime` 的新函数都要决定"泛型化还是退化"，这次 `spanLoop` 就是漏了一处。这是一类**会反复复发**的编译错。
3. **caller 与 plugin 强耦合**：`AgentSession<Ctx>` 要求 caller 在**创建 session 时**就固定住 `Ctx`，但携带 per-run 数据的其实是 plugin。数据的类型定义（plugin 侧）和类型参数的固定点（session 创建侧）被割裂。

## 决策

**引擎回到单态（monomorphic），per-run 数据改用 typed context keys。** 泛型从"横穿引擎的一条轴"塌缩为"挂在每个 key 上的一个点"。

### 原则

```
引擎类型（HookContext / Plugin / PluginHooks / Agent / AgentConfig /
  AgentRunOptions / PluginRunner / AgentRuntime / createAgent / AgentSession）
  → 全部去掉 <Ctx> 参数，变回单态。

per-run 数据的类型安全
  → 不靠引擎的类型参数，靠每个 ContextKey<T> 自己携带的 T 在 get/set 边界收窄。

每个 feature / plugin
  → 在自己的模块里 defineContext<T>(name) 声明 key + 拥有 T。
    零反向依赖：framework 不认识任何具体 T。
```

`ctx.data?: Ctx`（单槽 blob）被 `ctx.context: ContextStore`（多键、每键各自类型）取代。这与 ADR 0009-D 的意图（"technical-neutral、单态、feature 各自拥有类型"）一致，只是把"运行时 `as` 收窄"升级为"编译期 key 收窄"——去掉了 plugin 侧的 `as` 断言。

### 新增接口（framework）

```typescript
// packages/framework/src/context.ts

/** 带 T 品牌的键，T 只在编译期存在（phantom）。 */
export interface ContextKey<T> {
  readonly name: string;
  /** 从 store 或 HookContext 读本键的值，缺席返回 undefined。 */
  get(source: ContextStore | { context: ContextStore }): T | undefined;
}

/** 不透明的 per-run 数据袋。引擎持有它但从不读内容。 */
export interface ContextStore {
  get<T>(key: ContextKey<T>): T | undefined;
  set<T>(key: ContextKey<T>, value: T): void;
  has<T>(key: ContextKey<T>): boolean;
  delete<T>(key: ContextKey<T>): void;
  clear(): void;
}

/** 声明一个 typed context key，name 作为内部 map 键。 */
export function defineContext<T>(name: string): ContextKey<T>;

/** 默认 in-memory 实现（name-keyed Map）。 */
export function createContextStore(): ContextStore;
```

### 引擎类型的变化

```typescript
// 旧（泛型横穿）
export interface HookContext<Ctx = Record<string, unknown>> {
  data?: Ctx;
  // ...
}

// 新（单态 + 多键 store）
export interface HookContext {
  context: ContextStore;   // ← 永远存在（默认空 store），不再是 data?: Ctx
  // ...
}
```

`PluginRunner` 删除幻影字段 `readonly _ctx?: Ctx`——它是不变性的来源，一并消失。`AgentRunOptions.data?: Ctx` → `AgentRunOptions.context?: ContextStore`。

### 数据流

```
plugin 模块:  export const ConversationCtx = defineContext<ConversationContext>("conversation")

feature:      const store = createContextStore();
              ConversationCtx.set?(store, {...})   // 见下方 setContext 封装
              session.setContext(ConversationCtx, { id, surface, senderName, input })
                → AgentSession 内部 store.set(key, value)
                → prompt() → agent.run(input, { context: store })
                → create-agent run(): ctx.context = opts.context ?? emptyStore
plugin:       const conv = ConversationCtx.get(ctx)   // ← ConversationContext | undefined，无需 as
```

### 为什么这类 TS2345 变得结构上不可能

泛型 `Ctx` 不再是任何引擎类型的参数，`AgentRuntime` 只有一种形态 `AgentRuntime`（无参），`spanLoop(rt: AgentRuntime, ...)` 与调用点 `spanLoop(rt, ...)` 天然同型。"某个消费者忘了跟着泛型化"这件事没有了发生的土壤。类型安全从 plugin 侧的 `ctx.data as ConversationContext` 变成 `ConversationCtx.get(ctx): ConversationContext | undefined`——缺席是一等公民（返回 `undefined`），顺带正确覆盖 cron / orchestrator 这些没有 conversation 上下文的 run。

## 后果

- framework: 新增 `context.ts`（`ContextKey` / `ContextStore` / `defineContext` / `createContextStore`），`index.ts` 导出。
- framework: `HookContext` / `PluginHooks` / `Plugin` / `definePlugin` / `validatePlugins` / `AgentRunOptions` / `Agent` / `AgentConfig` / `PluginRunner` / `AgentRuntime` / `createAgent` / `createAgentInternal` / `createPluginRunner` 去掉 `<Ctx>` 参数。
- framework: `HookContext.data?: Ctx` → `HookContext.context: ContextStore`；`create-agent` 里 `ctx.data = opts.data` → `ctx.context = opts.context ?? emptyStore`，`ctx.data = undefined` → `ctx.context = emptyStore`（run 结束复位）。
- framework: `PluginRunner` 删除幻影 `_ctx`，`plugin-dispatcher` 删除返回对象里的 `_ctx: undefined`。
- harness: `AgentSession<Ctx>` → `AgentSession`；`#data: Ctx` → 内部持有 `ContextStore`；`setData(value: Ctx)` → `setContext<T>(key: ContextKey<T>, value: T)`；`agent.run/continue({ data })` → `({ context })`。
- plugin-conversation-context: 导出 `export const ConversationCtx = defineContext<ConversationContext>("conversation")`；`beforeModel` 用 `ConversationCtx.get(ctx)` 读，删掉 `ctx.data as` 断言。
- backend conversation-compose: `session.setData({...})` → `session.setContext(ConversationCtx, {...})`。
- 消除 3× TS2345，`bun run typecheck` 归零，collapse-harness spec 验收标准可真正达成。
- 与 ADR 0009-D 的关系：**纠正**其落地偏差（`data?: Ctx` 泛型 → 回到单态 + keyed），并在 0009-D 的 `context?: unknown` 基础上再进一步——用编译期 key 收窄取代运行时 `as`。

### 与 0009 落地实现的差异

| | 93122efb 实现 | 本 ADR |
|---|---|---|
| HookContext | `HookContext<Ctx>` + `data?: Ctx` | `HookContext`（单态）+ `context: ContextStore` |
| 类型参数 | `Ctx` 横穿 12+ 引擎类型 | 引擎零类型参数 |
| per-run 数据 | 单槽 `Ctx` blob | 多键 `ContextStore`，每键各自 `T` |
| 类型收窄 | plugin `ctx.data as X` | `Key.get(ctx): X \| undefined`（无 `as`） |
| 谁固定类型 | caller 建 session 时固定 `Ctx` | 各 plugin 在自己模块 `defineContext<T>` |
| 无 conversation 场景 | `ctx.data` 为 `{}`/undefined，需判空 | `Key.get(ctx)` 返回 `undefined`，一等公民 |
| `AgentRuntime` 消费者漏泛型化 | TS2345（本 bug） | 单态，结构上不可能 |

## 关联

- [ADR 0008](./0008-collapse-harness-invocation-layer.md) — 塌缩 harness 调用层
- [ADR 0009](./0009-session-layer-owns-identity-features-own-binding.md) — 补充决策 D 规定 `context?: unknown`，本 ADR 纠正其落地偏差
- [修复 plan](../superpowers/plans/2026-07-07-typed-context-keys.md) — 逐文件 handoff、伪代码、函数签名、范型传播
- [设计哲学 §2](../architecture/design-philosophy.md) — 暴露业务，隐藏机制
