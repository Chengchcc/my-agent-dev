---
id: runtime.framework
title: Agent 运行循环
status: current
owners: architecture
last_verified_against_code: 2026-07-28
summary: "Agent 运行循环是 Agent 真正「思考-行动」的运行时核心。它的心脏是 spanLoop：一个受 maxSteps 与 maxForceContinues 约束的循环，每一步可能调模型、可能调工具，并把过程拆成一串结构化 AgentEvent 往外吐。围绕循环还有一组生命周期钩子和三个拆分后的持久化端口（MessageStore / EventLog / InterruptStore），分别负责「在关键节点插手」和「断点存取」。"
depends_on:
used_by:
  - runtime.context-manager
  - runtime.plugin
  - plugins.task-guard
---

# Agent 运行循环

Agent 运行循环是 Agent 真正「思考-行动」的运行时核心。它的心脏是 `spanLoop`（`packages/agent/src/runtime/span-loop.ts`）：一个受 `maxSteps` 与 `maxForceContinues` 约束的循环，每一步可能调模型、可能调工具，并把过程拆成一串结构化 `AgentEvent` 往外吐。围绕循环还有一组生命周期钩子和三个拆分后的持久化端口（`MessageStore` / `EventLog` / `InterruptStore`），分别负责「在关键节点插手」和「断点存取」。

> **P11 起**：旧的 `framework` 包已合并进 `packages/agent`。旧的主循环 `runLoop` 重命名为 `spanLoop`。旧的 `Checkpointer` 复合接口已拆分为三个独立端口。

## spanLoop：一步一步推进

`spanLoop` 是驱动 Agent 的主循环。每一轮迭代里，Agent 要么向模型发起一次调用，要么执行一次工具调用，循环持续直到自然停止或触达上限。两个上限保护它不会失控：

- `maxSteps`，默认 **32**：一次运行最多推进多少步。
- `maxForceContinues`，默认 **3**：当 Agent 想要提前停下、但还有未完成的工作时，循环可以「强制再继续」的次数上限。这是对抗「过早收尾」的闸门--它给 Agent 有限次机会去把活干完，但又不会无限续命。

每一步要调模型前，循环先经过两道整形：先由[上下文管理器](context-manager.md) `shape()` 决定本次喂给模型的历史形状（裁剪/压缩），再由插件的 `beforeModel` 钩子在这份历史上注入记忆、技能等临时内容。两者产出只用于这一次模型调用，不持久改写线程。

## AgentEvent：循环对外的唯一语言

循环内部发生的一切，都被翻译成一个判别联合 `AgentEvent` 往外发：

| 事件 | 含义 |
|------|------|
| `message` | 一条完整消息（经进程内 Agent 透出后，由 Backend 的 `onRunMessage` [直写进账本](../conversation/history.md)，再由 `broadcastMessage` [扇出](../runs/output-and-live-updates.md)到前端） |
| `interrupted` | 运行被中断 |
| `error` | 运行出错 |
| `text_delta` | 文本streaming 增量 |
| `reasoning_delta` | 推理过程streaming 增量 |
| `tool_start` | 工具开始执行 |
| `tool_end` | 工具执行结束 |
| `todo_update` | 待办/计划更新 |
| `llm_call` | 一次模型调用 |
| `tool_call` | 一次工具调用 |

注意 `message` 与 `text_delta` 的分工：`message` 是事实候选（落账本），`*_delta` 是给实时渲染看的流。

## 生命周期钩子

围绕循环的关键节点，运行时暴露两组钩子接口，让插件与调用方在不改循环本体的前提下插手：

- **`PluginHooks`**（`packages/agent/src/runtime/plugin.ts`）--插件系统的内部钩子，携带 `HookContext`（含 `messageStore` / `eventLog` / `interruptStore` / `contextManager`），在 `beforeRun` / `beforeModel` / `afterModel` / `beforeTool` / `afterTool` / `beforeStop` 节点触发。
- **`AgentHooks`**（`packages/agent/src/agent-hooks.ts`）--公开 API 的钩子，使用冒号分隔的命名（`before:run` / `before:model` / ...）和 `AgentContext`（含 `state: RunState`）。`createHookPlugin()` 把 `AgentHooks` 适配成 `PluginHooks` 注入循环。

`beforeRun` - 运行开始前
`beforeModel` / `afterModel` - 每次模型调用的前后
`beforeTool` / `afterTool` - 每次工具调用的前后
`beforeStop` - 循环准备停下前（task-guard逻辑常挂在这里）

这套钩子是 task-guard、observability 等插件的接入点。

## M22 增强：工具并行与运行中干预

M22 为 spanLoop 增加了两个关键能力：

### 回合内工具并行

工具可通过 `executionMode` 声明执行策略。标记为 `"concurrent"` 的只读工具在同一回合内并发执行，而非逐个串行。模型返回多个 `tool_use` 时，并发批次内的工具同步启动，待全部完成后统一收集 `tool_result` 并配对回消息历史。串行（`"sequential"`，默认）与并行工具可混合：同一回合内先跑完所有串行工具，再成批跑并行工具。并行工具的 `tool_result` 按 `tool_use` 原始顺序插入，保证消息序列合法。

### 运行中干预（Steering + Follow-up）

入 spanLoop 时消息集不再固定。新增两个队列接口：

- **SteeringQueue**：运行中每步开始时排出用户干预消息，注入当前回合上下文。适合中途纠偏、补充约束。
- **FollowUpQueue**：外层循环在每次 run 自然结束后检查是否有待处理的跟进消息，有则触发新一轮 run 而非立刻停。适合「下一轮再收口」这类延迟干预。

两者让长任务运行可被中途干预而无需打断重启，同时保持循环本体的单向推进语义。

运行循环返回的 `Agent` 对象（内部接口，`packages/agent/src/runtime/agent-options.ts`）暴露四种执行入口：

### run(input, opts?)

标准入口，追加用户消息后启动运行循环。

```ts
run(input: string, opts?: AgentRunOptions): AsyncIterable<AgentEvent>
```

### continue(opts?)


```ts
continue(opts?: AgentRunOptions): AsyncIterable<AgentEvent>
```

实现上，`continue()` 和 `run()` 共享同一运行逻辑--区别仅在于 `continue()` 不推送新 user message，且会在入口处校验线程中至少有一条 user 消息。

### fork(messages?, id?)

创建新的 `Agent` 实例，**共享**配置（model、systemPrompt、plugins、`messageStore` / `eventLog` / `interruptStore`）但拥有**独立**的消息线程。不复制历史时默认 `structuredClone` 当前消息；也可显式传入 `messages` 数组和可选的 `sessionId`。

```ts
fork(messages?: Message[], id?: string): Agent
```

典型用途：在验证回合（cold-review）中用 fork 克隆一个 Agent，注入验证提示单独跑一轮，而原 Agent 保持原样。

### resume(command, opts?)

从中断恢复运行。`command` 使用 `ResumeCommand` 类型：

```ts
interface ResumeCommand {
  approved: boolean;   // 是否批准被中断的操作
  message?: string;    // 可选的附加消息（如拒绝原因）
}
```

恢复时框架会找到中断对应的占位 tool_result，替换为真实结果（`approved` 决定 `is_error` 字段），然后继续执行循环。

## 持久化端口（MessageStore / EventLog / InterruptStore）

旧版单一 `Checkpointer` 复合接口在 P11 拆分为三个职责单一的端口，定义于 `packages/agent/src/persistence/`。具体后端（进程内全局 `checkpointer.db`，见[标识符体系](../foundations/identifiers.md)）分别实现它们。

### MessageStore -- 消息存取

```ts
interface MessageStore {
  load(sessionId: string): Promise<Message[] | null>;
  save(sessionId: string, messages: readonly Message[]): Promise<void>;
  deleteThread?(sessionId: string): Promise<void>;
}
```

读取上次断点 / 保存正常推进的消息。`load` / `save` 成对出现，服务于 compact 与线程恢复。

### EventLog -- 执行事件追加

```ts
interface EventLog {
  appendEvent(sessionId: string, spanId: string | undefined, event: CheckpointEvent): Promise<void>;
  readEvents(sessionId: string, opts?: { spanId?: string }): AsyncIterable<CheckpointEventRow>;
}
```

追加执行事实事件（模型调用、工具调用、force_continue 等），支持按 span 过滤回读。用于 `getUsage()` 统计与可观测性。

### InterruptStore -- 中断状态存取

```ts
interface InterruptStore {
  saveInterrupt(sessionId: string, state: InterruptState): Promise<void>;
  consumeInterrupt(sessionId: string): Promise<InterruptState | null>;
}
```

`saveInterrupt` / `consumeInterrupt` 成对出现，专门服务于「中断-恢复」：中断时把状态封存，恢复时取出并清除，避免同一个中断被消费两次。

> 物理层 `checkpointer.db`、`checkpoint_messages` / `checkpoint_events` / `checkpoint_interrupts` 表名是存储兼容标识，未随接口拆分改名。

## 关联页面

- [上下文管理器](context-manager.md)
- [运行时插件](plugin.md)
- [task-guard plugin](../plugins/task-guard.md)
- [会话投影](../runs/output-and-live-updates.md)
- [依赖注入](../foundations/dependency-injection.md) -- DI 手法与 spanLoopOpts 透传
- [标识符体系](../foundations/identifiers.md) -- runId / threadId 的分工与回退
