# 修复 Plan: Typed Context Keys — 引擎单态化 handoff

依据：[ADR 0010](../../adr/0010-typed-context-keys.md) · 纠正 [ADR 0009-D](../../adr/0009-session-layer-owns-identity-features-own-binding.md) 落地偏差

## 交付形态

本文件是**可交接的施工说明**：接手者按顺序执行即可，无需回看对话。每一步给出**文件、函数签名、接口字段、伪代码、范型传播方向**。全程不引入新运行时依赖，纯类型 + 一个小 store 实现。

## 0. 复现与基线

```bash
export PATH="$HOME/.bun/bin:$PATH"
git rev-parse HEAD          # 应为 93122efb
bun run typecheck 2>&1 | grep TS2345
# 期望看到 3 行：
#   create-agent.ts(196,41): error TS2345: AgentRuntime<Ctx> !~> AgentRuntime<Record<string, unknown>>
#   create-agent.ts(243,41): 同
#   create-agent.ts(302,41): 同
bun test packages/framework/   # 137 pass（Bun 不做 tsc，故 bug 不可见）
```

**根因链**（务必先理解再动手）：

```
createAgent<Ctx>                         无约束泛型
  └─ rt: AgentRuntime<Ctx>               携带 Ctx
        └─ plugins: PluginRunner<Ctx>
              └─ readonly _ctx?: Ctx     ← 幻影字段使 AgentRuntime 对 Ctx 【不变 invariant】
  └─ spanLoop(rt, ...)                   spanLoop(rt: AgentRuntime)【非泛型】→ 默认 Record<string,unknown>
                                          AgentRuntime<Ctx> 不能赋给 AgentRuntime<Record<string,unknown>>
                                          → TS2345 ×3
```

修复方向：**删除贯穿引擎的 `Ctx` 轴**（含幻影 `_ctx`），per-run 数据改由 `ContextStore` + `ContextKey<T>` 承载。范型只在 `defineContext<T>` / `ContextKey<T>` / `store.get<T>/set<T>` 这些**局部点**存在，不再横穿类型层。

---

## 范型传播总览（先看方向，再看逐文件）

改动前——`Ctx` 是一条**纵向轴**，从 caller 一路穿到引擎底层：

```
AgentSession<Ctx>
  → createAgent<Ctx>(AgentConfig<Ctx>)
    → HookContext<Ctx>.data?: Ctx
    → PluginRunner<Ctx>._ctx?: Ctx        （不变性来源）
    → AgentRuntime<Ctx>.plugins
      → spanLoop(AgentRuntime)            ← 轴在这里断裂 → TS2345
    → Plugin<Ctx> / PluginHooks<Ctx>
    → AgentRunOptions<Ctx>.data?: Ctx
```

改动后——引擎全单态，范型退化为**横向的、挂在每个 key 上的点**：

```
引擎：AgentSession / createAgent / HookContext / PluginRunner /
      AgentRuntime / Plugin / PluginHooks / AgentRunOptions
      —— 全部无类型参数（monomorphic）

范型只活在：
  defineContext<T>(name): ContextKey<T>              // 声明点，T 由 feature 决定
  ContextStore.get<T>(key: ContextKey<T>): T | undefined   // 读点，T 由 key 带出
  ContextStore.set<T>(key: ContextKey<T>, value: T)         // 写点，T 由 key 约束
  ContextKey<T>.get(ctx): T | undefined              // plugin 读点，收窄无需 as
  AgentSession.setContext<T>(key: ContextKey<T>, value: T)  // caller 写点
```

关键洞察：`T` 不再需要在任何一个"引擎类型"上出现，因此没有任何消费者需要"决定是否跟着泛型化"。`spanLoop(rt: AgentRuntime, ...)` 与 `spanLoop(rt, ...)` 天然同型，TS2345 从结构上消失。

---

## Step 1 — 新增 `packages/framework/src/context.ts`（纯新增）

**目的**：定义 `ContextKey<T>` / `ContextStore` / `defineContext` / `createContextStore`。这是范型唯一合法的落脚点。

**范型逻辑**：`ContextKey<T>` 用一个 `unique symbol` 品牌位携带 `T`（phantom，运行时不存在）。`defineContext<T>(name)` 把闭包 `get` 绑到这个 key 上，`get` 内部对同一个 key 调 `store.get(key)`，因为 `store.get<T>(key: ContextKey<T>)` 的 `T` 由入参 key 推断，返回 `T | undefined`——**收窄不靠 `as`，靠 key 的 T 推断**。

```typescript
const CONTEXT_KEY_BRAND: unique symbol = Symbol("context-key");

export interface ContextKey<T> {
  readonly name: string;
  readonly [CONTEXT_KEY_BRAND]?: T;                 // phantom，仅编译期携带 T
  get(source: ContextStore | { context: ContextStore }): T | undefined;
}

export interface ContextStore {
  get<T>(key: ContextKey<T>): T | undefined;
  set<T>(key: ContextKey<T>, value: T): void;
  has<T>(key: ContextKey<T>): boolean;
  delete<T>(key: ContextKey<T>): void;
  clear(): void;
}

export function defineContext<T>(name: string): ContextKey<T> {
  const key: ContextKey<T> = {
    name,
    get(source) {
      const store = "context" in source ? source.context : source;  // 支持传 ctx 或 store
      return store.get(key);                                          // T 由 key 带出
    },
  };
  return key;
}

export function createContextStore(): ContextStore {
  const map = new Map<string, unknown>();                            // 内部按 name 存
  return {
    get<T>(key: ContextKey<T>) { return map.get(key.name) as T | undefined; },
    set<T>(key: ContextKey<T>, value: T) { map.set(key.name, value); },
    has(key) { return map.has(key.name); },
    delete(key) { map.delete(key.name); },
    clear() { map.clear(); },
  };
}
```

> `map` 的 `as T` 是**实现内部**的唯一断言（Map 无法带类型键），对外 API `get<T>` 完全类型安全。这是把"全局 `as` 散落各 plugin"收敛成"一处受控 `as`"。

**导出**（`packages/framework/src/index.ts`，与现有 export 同风格）：

```typescript
export {
  type ContextKey,
  type ContextStore,
  createContextStore,
  defineContext,
} from "./context.js";
```

---

## Step 2 — `packages/framework/src/plugin.ts`（去泛型 + 换字段）

**签名变更**（删掉每个 `<Ctx = Record<string, unknown>>`）：

| 旧 | 新 |
|---|---|
| `HookContext<Ctx>` | `HookContext` |
| `PluginHooks<Ctx>` | `PluginHooks` |
| `Plugin<Ctx>` | `Plugin` |
| `definePlugin<Ctx>(def): Plugin<Ctx>` | `definePlugin(def): Plugin` |
| `validatePlugins<Ctx>(plugins, tools)` | `validatePlugins(plugins, tools)` |

**字段变更**（`HookContext`）：

```typescript
import type { ContextStore } from "./context.js";

export interface HookContext {
  sessionId: string;
  span?: RunSpan;
  signal?: AbortSignal;
  logger: Logger;
  checkpointer: Checkpointer;
  contextManager: ContextManager;
  emit?(event: AgentEvent): void;
  context: ContextStore;        // ← 原 data?: Ctx。注意【非可选】：引擎保证永远有一个（可能为空）store
}
```

`PluginHooks` 里所有 `ctx: HookContext<Ctx>` 改成 `ctx: HookContext`。其余方法体不动。

---

## Step 3 — `packages/framework/src/agent-options.ts`（去泛型 + 删幻影）

删除每个 `<Ctx = Record<string, unknown>>`：`AgentRunOptions` / `Agent` / `AgentConfig` / `PluginRunner` / `AgentRuntime`。

**两处关键字段**：

```typescript
import type { ContextStore } from "./context.js";

export interface AgentRunOptions {
  // ...原字段不变...
  origin?: unknown;
  context?: ContextStore;       // ← 原 data?: Ctx（可选：不传则引擎用空 store）
}

export interface PluginRunner {
  // ← 删除 readonly _ctx?: Ctx;   （这行是 invariant 与 TS2345 的根源）
  fireBeforeModel(msgs: Message[]): Promise<Message[]>;
  // ...其余方法签名不变...
}
```

`Agent` 内所有 `AgentRunOptions<Ctx>`→`AgentRunOptions`、`Agent<Ctx>`→`Agent`；`AgentConfig.plugins?: readonly Plugin<Ctx>[]`→`readonly Plugin[]`；`AgentRuntime.plugins: PluginRunner<Ctx>`→`PluginRunner`。

---

## Step 4 — `packages/framework/src/plugin-dispatcher.ts`（去泛型 + 删 `_ctx`）

```typescript
export function createPluginRunner(       // ← 删 <Ctx>
  plugins: readonly Plugin[],             // ← Plugin<Ctx> → Plugin
  ctx: HookContext,                       // ← HookContext<Ctx> → HookContext
  logger: Logger,
): PluginRunner {                         // ← PluginRunner<Ctx> → PluginRunner
  async function eachPlugin(hookName: string, fn: (p: Plugin) => Promise<void>) { /* 不变 */ }
  return {
    async fireBeforeModel(msgs) { /* 不变 */ },
    // ...
    // ← 删除返回对象末尾的 `_ctx: undefined,`
  };
}
```

方法体逻辑一行不改，只删类型参数与 `_ctx`。

---

## Step 5 — `packages/framework/src/create-agent.ts`（去泛型 + store 生命周期）

**签名**：`createAgent<Ctx>(config: AgentConfig<Ctx>): Promise<Agent<Ctx>>` → `createAgent(config: AgentConfig): Promise<Agent>`；`createAgentInternal<Ctx>(...)` 同理去参；`validatePlugins<Ctx>`→`validatePlugins`；`createPluginRunner<Ctx>`→`createPluginRunner`；`ctx: HookContext<Ctx>`→`HookContext`；`rt: AgentRuntime<Ctx>`→`AgentRuntime`；`spanLoopOpts(opts: AgentRunOptions<Ctx>)`→`AgentRunOptions`；`fork(...): Agent<Ctx>`→`Agent`；三个 `run/continue/resume(opts: AgentRunOptions<Ctx> = {})`→`AgentRunOptions`。

**store 生命周期**（伪代码，替换现有 `ctx.data` 三对读写）：

```typescript
import { createContextStore } from "./context.js";

const emptyStore = createContextStore();          // 复用的空 store（run 之间复位到它）
const ctx: HookContext = {
  sessionId: thread.id,
  signal: undefined,
  logger, checkpointer, contextManager,
  emit: (e) => { pendingEvents.push(e); },
  context: emptyStore,                            // ← 原 data: undefined
};

// run() / continue() / resume() 每个的 run-start：
ctx.context = opts.context ?? emptyStore;         // ← 原 ctx.data = opts.data;

// 每个的 finally：
ctx.context = emptyStore;                         // ← 原 ctx.data = undefined;
```

> 用共享 `emptyStore` 而非每次 `createContextStore()`，避免无 context 的 run（cron/orchestrator）产生垃圾分配。plugin 读空 store 得到 `undefined`，行为与旧 `data === undefined` 一致。

**三个 `spanLoop(rt, spanLoopOpts(opts))` 调用点**：不用改——`rt` 现在是 `AgentRuntime`，`spanLoop(rt: AgentRuntime, ...)` 同型，TS2345 自动消失。删除之前为绕过编译错加的 `rt as AgentRuntime` cast。

---

## Step 6 — `packages/harness/src/agent-session.ts`（去泛型 + setContext）

**类签名**：`class AgentSession<Ctx = Record<string, unknown>>` → `class AgentSession`。

**内部字段**：`#data: Ctx | undefined` → 持有一个 store：

```typescript
import { type ContextKey, type ContextStore, createContextStore } from "@chengchenccc/framework";

#pendingContext: ContextStore | undefined;        // 原 #data

setContext<T>(key: ContextKey<T>, value: T): void {    // 原 setData(value: Ctx)
  if (!this.#pendingContext) this.#pendingContext = createContextStore();
  this.#pendingContext.set(key, value);
}
```

**`#agent` 字段**：`#agent: Agent<Ctx> | null` → `Agent | null`；`createAgent<Ctx>({...})` → `createAgent({...})`；`plugins: this.#config.plugins as readonly Plugin<Ctx>[]` → `as readonly Plugin[]`（或直接去掉 as）。

**`#executeSpan` 里传参**（两处 `data: this.#data` + 两处 `this.#data = undefined`）：

```typescript
const generator = this.#agent.run(text, {
  signal, stream: true, maxSteps, steering, followUp,
  spanId: opts?.spanId, origin: opts?.origin,
  context: this.#pendingContext,                  // ← 原 data: this.#data
});
this.#pendingContext = undefined;                 // ← 原 this.#data = undefined（run 后清）
```

> `setContext` 允许多次调用累积多个 key（多 plugin 各自的数据），这是 keyed 设计相对单槽 `setData` 的直接收益。

**导出**（`packages/harness/src/index.ts`）：`AgentSession` 无泛型，导出不变。若上游有 `AgentSession<X>` 用法需一并去参（本仓 grep 确认无具体实例化，见 Step 9 校验）。

---

## Step 7 — `packages/plugin-conversation-context/src/conversation-context-plugin.ts`

**新增导出 key**（模块顶层，feature 拥有类型）：

```typescript
import { defineContext } from "@chengchenccc/framework";

export interface ConversationContext {
  id: string; surface: string; senderName: string; input: string;
}

export const ConversationCtx = defineContext<ConversationContext>("conversation");
```

**`beforeModel` 读法**（删掉 `ctx.data as` 断言）：

```typescript
async beforeModel(ctx, messages) {
  const conv = ConversationCtx.get(ctx);          // ConversationContext | undefined，无 as
  if (!conv?.id) return messages;                 // 缺席一等公民：cron/orch 走这里直接透传
  const contextMsg: Message = { role: "system", text: `<conversation>...${escapeXml(conv.input)}...` };
  return [contextMsg, ...messages];
}
```

清掉文件里残留的 `setContext(CONVERSATION_KEY)` / `ctx.get()` 旧注释。`index.ts` 增加 `ConversationCtx` re-export。

---

## Step 8 — `apps/backend/src/features/conversation/conversation-compose.ts`

唯一 caller 改一处（`:174`）：

```typescript
import { ConversationCtx } from "@chengchenccc/plugin-conversation-context";

// 原：session.setData({ id: conversationId, surface, senderName: agentMemberId, input: input ?? "" });
session.setContext(ConversationCtx, {
  id: conversationId, surface, senderName: agentMemberId, input: input ?? "",
});
session.prompt(input ?? "", { spanId, origin: { conversationId, agentMemberId: agentId, surface, originKind: "manual" } });
```

`prompt` opts 不变（`context` 由 `setContext` 内部 buffer，prompt 内部读 `#pendingContext` 传入 `agent.run`）。

---

## Step 9 — 测试与验证

**测试改动**（`conversation-context-plugin.test.ts`，把 `data:` 改成 `context:`）：

```typescript
import { createContextStore } from "@chengchenccc/framework";
import { ConversationCtx } from "./conversation-context-plugin.js";

const store = createContextStore();
ConversationCtx.set?.(store, { id: "conv-1", surface: "web", senderName: "alice", input: "hi" });
// 或用 store.set(ConversationCtx, {...})
const events = await collect(agent.run("hi", { context: store }));   // 原 { data: conv as ... }
```

"does not inject when context is empty" 用例：`agent.run("test")` 不传 context，plugin 读 `ConversationCtx.get(ctx)` 得 `undefined`，透传，断言不变。

**先决 grep**（确认无具体泛型实例化，去参安全）：

```bash
grep -rn "createAgent<\|AgentSession<\|Agent<[A-Z]\|HookContext<\|Plugin<[A-Z]" apps packages --include="*.ts" | grep -v "= Record<string"
# 期望为空（只有默认参数声明，无 createAgent<Foo>() 之类具体实例化）
```

**验收**：

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun run typecheck        # 0 errors（3× TS2345 消失，全 8 包过）
bun run test             # 340 pass / 0 fail（collapse-harness spec 验收标准）
```

---

## 逐文件改动清单（施工核对表）

| # | 文件 | 动作 | 范型/字段要点 |
|---|------|------|--------------|
| 1 | `framework/src/context.ts` | 新增 | `ContextKey<T>`/`ContextStore`/`defineContext<T>`/`createContextStore` |
| 1 | `framework/src/index.ts` | 加 export | 4 个新符号 |
| 2 | `framework/src/plugin.ts` | 去 `<Ctx>` ×5 | `HookContext.data?:Ctx` → `context: ContextStore`（非可选） |
| 3 | `framework/src/agent-options.ts` | 去 `<Ctx>` ×5 | 删 `PluginRunner._ctx`；`AgentRunOptions.data?:Ctx`→`context?:ContextStore` |
| 4 | `framework/src/plugin-dispatcher.ts` | 去 `<Ctx>` | 删返回对象 `_ctx: undefined` |
| 5 | `framework/src/create-agent.ts` | 去 `<Ctx>` 全量 | `emptyStore`；`ctx.data`→`ctx.context` 三对读写；3 个 spanLoop 调用点自动修复 |
| 6 | `harness/src/agent-session.ts` | 去 `<Ctx>` | `setData`→`setContext<T>(key,value)`；`#data`→`#pendingContext: ContextStore` |
| 7 | `plugin-conversation-context/.../*.ts` | 加 `ConversationCtx` | `beforeModel` 用 `.get(ctx)`，删 `as` |
| 8 | `conversation/conversation-compose.ts` | 改 caller | `setData`→`setContext(ConversationCtx, {...})` |
| 9 | `plugin-conversation-context/.../*.test.ts` | 改测试 | `{ data }`→`{ context: store }` |

## 回滚

改动局限在类型层 + 一个小 store 实现，无 schema / 无 migration / 无运行时协议变更。回滚 = `git checkout` 上述 9 个文件。运行时行为与 93122efb 等价（空 context ≡ 旧 `data === undefined`）。
