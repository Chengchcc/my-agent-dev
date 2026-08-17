# M3 Spec — Framework 装配层

> 基于 M1 core 协议(L1+L2)和 M2 adapter/tools。
> 目标:用 `createAgent({ model, tools, systemPrompt, plugins, checkpointer })` 把 model+tools 封装成可复用的 Agent 实例，提供 thread/plugin/checkpointer/fork 四个正交能力。

---

## 一、设计原则（沿用 M1+M2，不重复展开）

1. **第一性原理** — 从 M1+L2 的 while 循环推导:L3 只是把 `run(model, tools, messages)` 的重复参数绑成一个对象，加上 thread 和 plugin
2. **奥卡姆剃刀** — plugin 是 plain object+4 个函数，不引入 middleware 链/onion/priority
3. **状态归调用方** — `agent.thread.messages` 公开读写，fork 即拷贝
4. **Rule of Three** — 3 个内置 plugin/checkpointer 触发抽象时机
5. **不引入新的心智模型** — Agent 内部还是 while 循环调 L2 `run()`，没有图/状态机/中间件链

---

## 二、四层架构中的位置

```text
┌────────────────────────────────────────────────────────────────┐
│ L4. Harness                                     (M4)           │
├────────────────────────────────────────────────────────────────┤
│ L3. Framework (createAgent)                      (M3)          │
├────────────────────────────────────────────────────────────────┤
│ L2. Runtime (run loop)                           (M1 core)     │
├────────────────────────────────────────────────────────────────┤
│ L1. Protocols                                    (M1 core)     │
└────────────────────────────────────────────────────────────────┘
```

M3 在 L2 之上、L4 之下,交付 `@chengchenccc/framework` 一个包。

依赖方向铁律：framework → core。框架不依赖 adapter-anthropic 或 tools-common。

---

## 三、M3 交付范围

### 3.1 新增

| 包 | 目录 | 职责 |
|---|---|---|
| `@chengchenccc/framework` | `packages/framework/` | `createAgent` + `Agent` + `definePlugin` + 内置 plugin/checkpointer |

### 3.2 不修改

- `packages/core/` — L1+L2 协议和运行时不变
- `packages/adapter-anthropic/` — 不变
- `packages/tools-common/` — 不变
- `apps/cli/` — 可以后续迁移到 `createAgent`，但 M3 不强制改

### 3.3 文档

- `docs/architecture/01-framework.md` — 框架层设计(已落盘)
- `docs/superpowers/specs/2026-06-04-m3-framework.md` — 本 spec
- `docs/superpowers/specs/2026-06-04-m3-retro.md` — M3 retro(交付时写)

---

## 四、`@chengchenccc/framework`

### 4.1 依赖

```json
{
  "dependencies": {
    "@chengchenccc/core": "workspace:*"
  }
}
```

### 4.2 createAgent

```ts
// packages/framework/src/create-agent.ts

import type { ChatModel, Tool, Message, RunOptions } from "@chengchenccc/core";

export interface Agent {
  readonly thread: Thread;
  run(input: string, options?: RunOptions): AsyncIterable<Message>;
  fork(messages?: Message[], id?: string): Agent;
}

export interface AgentConfig {
  model: ChatModel;
  tools?: readonly Tool[];
  systemPrompt?: string;
  plugins?: readonly Plugin[];
  checkpointer?: Checkpointer;
  /** 从已有 thread 恢复。需配合 checkpointer 使用 */
  threadId?: string;
}

export function createAgent(config: AgentConfig): Promise<Agent>;
```

**关键设计点:**

1. **`createAgent` 是 async** — 如果配了 `threadId` + `checkpointer`，先调 `checkpointer.load(threadId)` 恢复 messages；无则创建空 thread
2. **`systemPrompt`** — 如果设了且 messages 里还没有 system 消息，`createAgent` 不插入。`agent.run()` 第一次调用时插到 messages 首位
3. **`tools`** — 透传给 L2 `run()`，不持有副本
4. **`plugins`** — 数组顺序即调用顺序，不涉及优先级。Framework 在对应时刻遍历 plugins 依次 fire

### 4.3 Agent.run()

```ts
agent.run(input: string, options?: RunOptions): AsyncIterable<Message>
```

**执行流程（伪代码）：**

```ts
async *run(input, options = {}) {
  if (this.#running) {
    throw new Error("Agent is already running. Use fork() for concurrent conversations.");
  }
  this.#running = true;
  try {
    options.signal?.throwIfAborted();

    // 第一次 run 时自动插入 system prompt
    if (this.#systemPrompt && !this.thread.messages.some(m => m.role === "system")) {
      this.thread.messages.unshift({ role: "system", content: this.#systemPrompt });
    }

    this.thread.messages.push({ role: "user", content: input });

    for await (const msg of runL2(
      this.#model,
      this.#tools,
      this.thread.messages,
      { ...options, signal: options.signal },
    )) {
      yield msg;
    }

    // 纯文本 turn(无 tool_use)落盘
    await this.#checkpointer?.save(this.thread.id, this.thread.messages);
  } finally {
    this.#running = false;
  }
}
```

Wait——上面的伪代码漏了 plugin hooks。实际 L3 的 loop 不直接调 L2 `run()`，而是自己实现 while 循环以嵌入 hook：

```ts
async *run(input, options = {}) {
  if (this.#running) throw new Error("Agent is already running. Use fork() for concurrent conversations.");
  this.#running = true;
  try {
    options.signal?.throwIfAborted();

    if (this.#systemPrompt && !this.thread.messages.some(m => m.role === "system")) {
      this.thread.messages.unshift({ role: "system", content: this.#systemPrompt });
    }

    this.thread.messages.push({ role: "user", content: input });

    const ctx: HookContext = { threadId: this.thread.id, signal: options.signal };

    for (let step = 0; step < (options.maxSteps ?? 32); step++) {
      if (options.signal?.aborted) return;

      // fire beforeModel — plugin 可裁剪 messages
      let workingMessages = await fireBeforeModel(this.#plugins, ctx, this.thread.messages);

      const blocks = await collectModelStream(this.#model, workingMessages, options, ctx, this.#plugins);

      if (options.signal?.aborted) return;
      if (blocks.length === 0) return;

      const assistantMsg: Message = { role: "assistant", content: blocks };
      this.thread.messages.push(assistantMsg);
      yield assistantMsg;

      // fire afterModel
      await fireAfterModel(this.#plugins, ctx, this.thread.messages);

      const toolUses = blocks.filter(b => b.type === "tool_use");
      if (toolUses.length === 0) {
        await this.#checkpointer?.save(this.thread.id, this.thread.messages);
        return;
      }

      const results: ContentBlock[] = [];
      for (const call of toolUses) {
        if (options.signal?.aborted) return;

        // fire beforeTool
        const decision = await fireBeforeTool(this.#plugins, ctx, call, this.thread.messages);
        if (decision?.skip) {
          results.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: decision.result ?? "Tool skipped",
            ...(decision.result ? { is_error: true } : {}),
          });
          continue;
        }

        const input = decision?.input ?? call.input;
        const tool = this.#toolMap.get(call.name);
        const result = tool
          ? await executeTool(tool, input, options.signal)
          : { type: "tool_result", tool_use_id: call.id, content: `Tool not found: ${call.name}`, is_error: true };
        results.push(result);
      }

      if (options.signal?.aborted) return;

      const userMsg: Message = { role: "user", content: results };
      this.thread.messages.push(userMsg);
      yield userMsg;

      // fire afterTool — 每个 tool_use call 独立的 afterTool
      for (let i = 0; i < toolUses.length; i++) {
        await fireAfterTool(this.#plugins, ctx, toolUses[i]!, results[i]!, this.thread.messages);
      }

      await this.#checkpointer?.save(this.thread.id, this.thread.messages);
    }
  } finally {
    this.#running = false;
  }
}
```

**说明:**

- L3 不能直接调 L2 `run()` —— L2 内部自己 loop 调 model + 执行 tool，L3 要在每个事件点 fire hooks。所以 L3 重写 loop，但复用 M1 的 `collectStream` helper 和 tool 执行语义
- `await this.#checkpointer?.save(...)` 在 afterTool 之后、无 tool_use 时在 return 之前。只在 tool turn 保存，纯文本由 loop 结束后保存
- 纯文本 turn 在无 tool_use 时直接 return，此时 save 已调用

### 4.4 Agent.fork()

```ts
agent.fork(messages?: Message[], id?: string): Agent
```

复用 model/tools/plugins/checkpointer，创建新的 Agent 实例附带 `Thread( messages ?? structuredClone(this.thread.messages) , id ?? randomId() )`。

用于：并发对话、分支试探、A/B 对比。

### 4.5 Thread

```ts
// packages/framework/src/thread.ts

export interface Thread {
  readonly id: string;
  messages: Message[];
}
```

纯数据容器。`id` 默认 `crypto.randomUUID()`。`messages` 公开可读写。

---

## 五、Plugin

### 5.1 核心类型

```ts
// packages/framework/src/plugin.ts

export interface Plugin {
  readonly name: string;
  readonly hooks: PluginHooks;
}

export interface HookContext {
  threadId: string;
  signal?: AbortSignal;
}

export interface PluginHooks {
  beforeModel?(ctx: HookContext, messages: readonly Message[]): Message[] | Promise<Message[]>;
  afterModel?(ctx: HookContext, messages: readonly Message[]): void | Promise<void>;
  beforeTool?(ctx: HookContext, call: ToolUseBlock, messages: readonly Message[]):
    | { skip?: boolean; input?: unknown; result?: string }
    | void
    | Promise<...>;
  afterTool?(ctx: HookContext, call: ToolUseBlock, result: ToolResultBlock, messages: readonly Message[]):
    | void
    | Promise<void>;
}
```

### 5.2 definePlugin

```ts
// packages/framework/src/plugin.ts

export function definePlugin(definition: {
  name: string;
  hooks: PluginHooks;
}): Plugin;
```

类型安全的构造函数——调用方不需要手动 import `Plugin` 或 `PluginHooks` 类型。只写关心的钩子，其余自动推导为 `undefined`。

### 5.3 钩子语义(从架构文档继承,M3 spec 重述)

**两类钩子：**

- `before*` — 数据流钩子。返回值有语义：
  - `beforeModel` 返回裁剪后的 `Message[]`
  - `beforeTool` 返回 `{ skip }` / `{ input }` / `{ result }` / `undefined`
- `after*` — 副作用钩子。返回值被忽略。用于落盘/日志/上报

**`ctx` 永远是第一个参数。** 不传 `model`(插件不需要内省 LLM)。

**管道链：** 多个插件挂同一个 `before*` 时,按 `plugins` 数组顺序依次调用,上一个返回值作为下一个输入：

```ts
async function fireBeforeModel(plugins: readonly Plugin[], ctx: HookContext, msgs: readonly Message[]): Promise<Message[]> {
  let result = [...msgs];
  for (const p of plugins) {
    if (p.hooks.beforeModel) {
      result = (await p.hooks.beforeModel(ctx, result)) ?? result;
    }
  }
  return result;
}
```

**beforeTool skip 语义：**

| 返回值 | Framework 行为 |
|---|---|
| `{ skip: true }` | 不执行 tool，push `{ tool_use_id: call.id, content: "Tool skipped" }` |
| `{ skip: true, result: "权限被拒" }` | push `{ tool_use_id: call.id, content: "权限被拒", is_error: true }` |
| `{ input: x }` | 以改写后的 input 执行 tool |
| `undefined` | 原样执行 |

**错误隔离：**

- `before*` 抛错 → 整轮 abort，错误抛出到 `agent.run()` 调用方
- `after*` 抛错 → 吞掉 + `console.warn(pluginName, error)`

---

## 六、Checkpointer

### 6.1 核心类型

```ts
// packages/framework/src/checkpointer.ts

export interface Checkpointer {
  load(threadId: string): Promise<Message[] | null>;
  save(threadId: string, messages: Message[]): Promise<void>;
}
```

**Checkpointer 是独立字段，不是 plugin。** 理由：

- `load` 是被动查询(framework 问"有历史吗？")，不是事件回调——和 4 个钩子性质不同
- 一个 agent 只有一个 Checkpointer，不需要数组+优先级
- `save` 时机由 framework 决定(在 afterTool 之后)，插件不需要关心

### 6.2 时机

- `load` — `createAgent()` 内部，如果配了 `threadId` + `checkpointer`，await load
- `save` — Framework 在每次 afterTool 之后调 `checkpointer.save(threadId, messages)`；纯文本 turn(无 tool_use)在 loop 结束时保存

---

## 七、内置 Plugin

### 7.1 slidingWindow

```ts
// packages/framework/src/plugins/sliding-window.ts

export function slidingWindow(options: { maxTurns: number }): Plugin;
```

**挂载点：** `beforeModel`

**行为：** 保留最近 `maxTurns` 轮对话(system 消息 + user message + assistant message + tool_result message 为一轮)，移除更早的。

**实现要点:**

- 从后往前数 `maxTurns` 个完整 turn
- system 消息永远保留(在 messages 首位)
- 返回新数组，不修改原 messages

### 7.2 consoleLogger

```ts
// packages/framework/src/plugins/console-logger.ts

export function consoleLogger(): Plugin;
```

**挂载点：** `afterModel` + `afterTool`

**行为：** `console.log` 每次 model 调用和 tool 执行的关键信息。仅开发调试使用。

---

## 八、内置 Checkpointer

### 8.1 fileCheckpointer

```ts
// packages/framework/src/checkpointers/file-checkpointer.ts

export function fileCheckpointer(options: { path: string }): Checkpointer;
```

**实现：** `save` 用 `Bun.write(path, JSON.stringify({ threadId, messages }))`，`load` 用 `Bun.file(path).json()`。

如果文件不存在，`load` 返回 `null`(不抛错)。

**说明：** 单文件存储，不适用多 thread 场景。生产环境调用方可实现 `Checkpointer` 接口接入 Redis/DB。

---

## 九、包结构与导出

### 9.1 `packages/framework/`

```text
packages/framework/
├── package.json              # deps: @chengchenccc/core
├── tsconfig.json             # build:排除 *.test.ts
├── tsconfig.test.json        # typecheck:包含 src/**/*.ts
└── src/
    ├── create-agent.ts        # createAgent + Agent
    ├── create-agent.test.ts
    ├── thread.ts              # Thread 类型
    ├── plugin.ts              # Plugin, PluginHooks, HookContext, definePlugin
    ├── plugin.test.ts
    ├── checkpointer.ts        # Checkpointer 接口
    ├── plugins/
    │   ├── sliding-window.ts
    │   ├── sliding-window.test.ts
    │   ├── console-logger.ts
    │   └── console-logger.test.ts
    ├── checkpointers/
    │   ├── file-checkpointer.ts
    │   └── file-checkpointer.test.ts
    └── index.ts               # barrel export
```

### 9.2 导出

```ts
// packages/framework/src/index.ts

export { createAgent, type Agent, type AgentConfig } from "./create-agent.js";
export { type Thread } from "./thread.js";
export { definePlugin, type Plugin, type PluginHooks, type HookContext } from "./plugin.js";
export { type Checkpointer } from "./checkpointer.js";
export { slidingWindow } from "./plugins/sliding-window.js";
export { consoleLogger } from "./plugins/console-logger.js";
export { fileCheckpointer } from "./checkpointers/file-checkpointer.js";
```

**不导出内部 helper** —— `fireBeforeModel`/`fireAfterModel`/`fireBeforeTool`/`fireAfterTool` 是 framework 内部实现细节，调用方不需要接触。

### 9.3 M1/M2 模块不修改

- `packages/core/` — 协议和运行时不变
- `packages/adapter-anthropic/` — 不变
- `packages/tools-common/` — 不变

---

## 十、测试要求

### 10.1 `create-agent.test.ts` 场景清单

| # | 场景 | 断言 |
|---|---|---|
| 1 | **single-turn text** | `agent.run("hello")` → yield assistant text,messages 末尾是 assistant |
| 2 | **tool loop** | scripted model 调 tool → 第二轮返回 text → messages 完整(user+assistant+user+assistant) |
| 3 | **system prompt 自动插入** | 无 system messages → 第一次 run 后 messages[0] 是 system |
| 4 | **system prompt 不重复插入** | 已手动加过 system → run() 不重复 |
| 5 | **threadId + checkpointer 恢复** | load 返回历史 → agent.thread.messages 即历史 |
| 6 | **load 返回 null → 空 thread** | 无历史的 threadId → 空 thread |
| 7 | **并发 run 抛错** | 第一个 run 未结束时第二个调 run → 抛 "already running" |
| 8 | **fork 创建独立 agent** | fork() → 新 agent,不同 thread id,旧 agent 不受影响 |
| 9 | **beforeModel transform** | plugin 裁剪 messages → model.stream 只收到裁剪后的 |
| 10 | **beforeTool skip** | plugin 返回 { skip: true } → tool 不执行,fw push "Tool skipped" |
| 11 | **beforeTool skip + result** | plugin 返回 { skip: true, result: "denied" } → push is_error tool_result |
| 12 | **afterTool side-effect** | plugin 记录 tool 调用 → 副作用被执行 |
| 13 | **plugin 错误隔离(after*)** | afterModel 抛错 → 吞掉+warn,agent 继续 |
| 14 | **plugin 错误传播(before*)** | beforeModel 抛错 → agent.run 抛出 |
| 15 | **checkpointer save 被调** | agent.run() → afterTool 后 save 被调 |
| 16 | **abort 早抛** | 传入已 abort 的 signal → user 消息不 push |
| 17 | **maxSteps 防失控** | model 永远调 tool,maxSteps=2 → 2 步退出 |

### 10.2 `plugin.test.ts` 场景

| # | 场景 |
|---|---|
| 1 | `definePlugin` 返回合法 Plugin，name 正确 |
| 2 | `definePlugin` 只声明部分钩子，类型推倒正确 |

### 10.3 `sliding-window.test.ts` 场景

| # | 场景 |
|---|---|
| 1 | 保留最近 N 轮,丢弃早期 |
| 2 | system 消息永远保留 |
| 3 | 轮数不足 maxTurns 时全保留 |

### 10.4 `file-checkpointer.test.ts` 场景

| # | 场景 |
|---|---|
| 1 | save + load 往返正确 |
| 2 | load 不存在的 threadId 返回 null |

### 10.5 `console-logger.test.ts` 场景

| # | 场景 |
|---|---|
| 1 | smoke test — plugin 可创建,钩子不抛错 |

### 10.6 不在 M3 测的

- 真实 checkpointer 后端(Redis/DB)
- 多 plugin 组合后的精确执行顺序
- CLI 迁移到 createAgent(M4)

---

## 十一、CI Gate

沿用 M1/M2 工具链：

```bash
bun install
bun run format
bun run lint
bun run typecheck
bun run test
bun run build
```

Gate 通过标准同 M1：typecheck 0 error、lint 0 error、所有 test pass、build 产出 dist。

---

## 十二、Day-by-day 执行计划

### Day 1:骨架 + Thread + Plugin 类型

- 创建 `packages/framework/`，写 `package.json` / `tsconfig.json` / `tsconfig.test.json`
- 写 `thread.ts`(Thread 类型)
- 写 `plugin.ts`(Plugin / PluginHooks / HookContext / definePlugin)
- 写 `plugin.test.ts`
- `bun run typecheck && bun run test` 通过

### Day 2:createAgent + Agent.run

- 写 `create-agent.ts`(createAgent / Agent / AgentConfig)
- 写 4 个内部 helper：`fireBeforeModel` / `fireAfterModel` / `fireBeforeTool` / `fireAfterTool`
- 用 `echoModel` 写 `create-agent.test.ts` 场景 1-8
- `bun run test && bun run build` 通过

### Day 3:plugin 集成 + 边界测试

- 完成 `create-agent.test.ts` 场景 9-17(plugin 行为)
- 修复实现中的 hook 时机和管道链 bug
- 所有 test pass

### Day 4:内置 Plugin + Checkpointer

- 写 `sliding-window.ts` + 测试
- 写 `console-logger.ts` + 测试
- 写 `file-checkpointer.ts` + 测试
- 写 `index.ts` barrel export
- `bun run build` 通过

### Day 5:文档与 retro + 全 gate 验证

- 写 M3 retro(`docs/superpowers/specs/2026-06-04-m3-retro.md`)
- 更新 `docs/architecture/00-overview.md`(加 M3 行)
- 全 gate 通过：`bun run format && bun run lint && bun run typecheck && bun run test && bun run build`

---

## 十三、验收清单

- [ ] `bun install && bun run format && bun run lint && bun run typecheck && bun run test && bun run build` 全绿
- [ ] `@chengchenccc/framework` 公开 `createAgent` / `definePlugin` / `slidingWindow` / `consoleLogger` / `fileCheckpointer`
- [ ] `create-agent.test.ts` 17 个场景全部通过
- [ ] `plugin.test.ts` 2 个场景通过
- [ ] `sliding-window.test.ts` 3 个场景通过
- [ ] `file-checkpointer.test.ts` 2 个场景通过
- [ ] `console-logger.test.ts` smoke test 通过
- [ ] M1+M2 已有测试全部通过(无退化)
- [ ] `docs/superpowers/specs/2026-06-04-m3-retro.md` 已写
- [ ] `docs/architecture/00-overview.md` 已更新

---

## 十四、后续 milestone 占位(不变)

| Milestone | 内容 |
|---|---|
| M4 | `@chengchenccc/harness-coding`: oma(system prompt + built-in tools) |
| M5 | 复审 — 出现 3+ 重复时才提取 `decorators` 共享包 |

---

**Spec 结束。**
