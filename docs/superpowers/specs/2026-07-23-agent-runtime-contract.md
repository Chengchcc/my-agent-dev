# Agent Runtime 重构契约

> 状态：draft contract，供后续 implementation plans 和 agent handoff 使用。
>
> 上游决策：[`docs/adr/0016-agent-runtime.md`](../../adr/0016-agent-runtime.md)
>
> 本文冻结跨 phase 的公共边界和不变量。执行 agent 不得自行修改本契约；发现契约缺口时必须停止当前任务并报告。

## 1. 目标

把 Agent 生命周期从 `packages/harness` 与 `packages/framework` 的分裂状态收敛到 `packages/agent`：

```text
backend → @my-agent-team/agent → core
```

迁移期间允许：

```text
@my-agent-team/agent → @my-agent-team/framework
```

这是临时内部适配，不是最终公共边界。

## 2. 领域不变量

1. `Agent` 是一个可恢复的生命周期实体。
2. 一个 Agent 同时最多拥有一个 active run。
3. `Agent` 决定 run 的 terminal state；Conversation 不决定 Agent 是否完成。
4. `Message` 是唯一消息本体；streaming revision、ledger record、surface delivery 不是新的消息领域模型。
5. `Conversation` 只负责 Conversation 业务和 Message projection，不负责 Agent 内部状态机。
6. Capability 不直接写 Conversation ledger。
7. Agent runtime 不依赖 backend Services、SQLite、Elysia、React 或具体 surface。
8. `sessionId` 由 SessionManager 生成，不编码 `conversationId`、`memberId`、`cronJobId` 或 `loopId`。
9. Conversation 的持久 session 绑定由 Conversation 自己保存；Cron、Loop 等一次性运行不复用 Conversation 绑定。
10. `checkpoint_events` 用于 audit/replay/troubleshooting，不作为 Web/Lark 的用户消息契约。
11. 数据库 schema 和持久化文件格式在本次 runtime migration 中保持兼容；除非另有独立 migration plan，不改表名和列语义。

## 3. Agent 公共边界

第一阶段的 `@my-agent-team/agent` 必须提供以下行为：

```ts
export type AgentState =
  | 'idle'
  | 'running'
  | 'compacting'
  | 'retrying'
  | 'waiting'
  | 'done'
  | 'error';

export interface Agent {
  readonly sessionId: string;
  readonly state: AgentState;

  prompt(input: string, opts?: PromptOptions): Promise<void>;
  continue(opts?: RunOptions): Promise<void>;
  resume(command: ResumeCommand, opts?: RunOptions): Promise<void>;

  abort(): void;
  dispose(): void;
  waitForIdle(): Promise<void>;

  steer(input: string): void;
  followUp(input: string): void;

  compact(instructions?: string): Promise<CompactionResult>;
  subscribe(listener: AgentEventListener): () => void;

  getContextUsage(): ContextUsage | undefined;
  getUsage(): Promise<number>;
}
```

实际字段类型可以复用现有实现，但新包的 backend caller 不得需要 import `@my-agent-team/framework` 才能使用这些行为。
The signatures below are target boundary sketches. Before implementation, each workstream must map them to concrete exported types in the current package; an agent must not invent `any`-typed placeholders or leave unresolved names in a buildable package.

The minimum concrete aliases are:

```ts
export type PromptOptions = RunOptions & {
  origin?: unknown;
  context?: RunState;
};

export interface RunOptions {
  signal?: AbortSignal;
  maxSteps?: number;
  stream?: boolean;
  maxForceContinues?: number;
  spanId?: string;
  origin?: unknown;
  context?: RunState;
}

export interface RunInput {
  text: string;
}

export interface AgentContext {
  sessionId: string;
  spanId?: string;
  signal?: AbortSignal;
  state: RunState;
}
```

`Usage`, `CompactionResult`, `ContextUsage`, `Message`, `ToolUseBlock`, `ToolResultBlock`, `ResumeCommand`, `AgentEvent`, and `AgentEventListener` must be imported from an existing package or defined in the same public package before use. A task may choose different names only if it updates this contract before implementation.

The first implementation may retain `ContextStore`, `AgentRunOptions`, and framework event types internally. Those compatibility names must not leak into new backend caller imports after the adoption workstream.

### 3.1 生命周期语义

- 首次 `prompt()` 初始化内部 runtime。
- 运行中再次 `prompt()` 路由为 steering，不创建第二个 run。
- `continue()` 不新增 user message。
- `resume()` 只能消费当前 session 的 pending interrupt。
- interrupted Agent 保持可 resume；terminal run 才允许由 owner dispose。
- `dispose()` 取消 active signal、移除订阅、清空 steering/follow-up 队列，并回到 `idle`。
- 同一 Agent 的并发执行必须被拒绝或序列化；不得交错写入同一 thread。

### 3.2 Retry / Compaction

必须保持当前 observable behavior：

- retry 次数、backoff、`auto_retry_start`、`auto_retry_end` 事件继续存在。
- retry 成功最终为 `succeeded`，耗尽最终为 `error`。
- compact 失败保留原消息，不破坏 thread。
- compact 成功更新内存 thread 和持久存储，并发出 `compaction_start` / `compaction_end`。
- steering/follow-up 不因 retry 或 compaction 丢失。

### 3.3 Interrupt / Resume

```text
tool throws InterruptSignal
  → 保存 interrupt state
  → 发出 interrupted
  → 保持 Agent live
  → resume(command)
  → 原子 consume interrupt
  → 继续执行
```

同一个 interrupt 不得被消费两次。

## 4. AgentEvent 边界

现有 `packages/framework/src/agent-event.ts` 是迁移期间的行为基线。新 Agent 可以先复用或适配它，但不能改变 payload 语义。

### 4.1 可供 backend projection 消费的事件

```text
agent_start
message
message_update
interrupted
agent_end
queue_update
compaction_start
compaction_end
auto_retry_start
auto_retry_end
todo_update
pet_bark
recap_update
```

### 4.2 运行审计事件

```text
llm_call
tool_execution_start
tool_call
```

这些事件用于 audit、usage、troubleshooting，不直接成为 Conversation Message。

### 4.3 事件规则

- `message` 和 `message_update` 通过同一 `messageId` 表示 revision，不得重复创建逻辑消息。
- `todo_update` 必须携带能关联当前 run 的 `spanId`，或有等价稳定关联方式。
- `agent_end` 的 status 只能是 `succeeded`、`error`、`interrupted`。
- Agent 内部不得让 Capability 任意伪造 `agent_end`、`interrupted` 等生命周期事件。
- 对外公开 `subscribe` / `on`；不公开任意 payload 的 `emit` 作为外部写入口。

## 5. AgentHooks

AgentHooks 是 Agent runtime 的扩展协议，不等同于 backend Capability。

```ts
export interface AgentHooks {
  'before:run'?: (
    ctx: AgentContext,
    input: RunInput,
  ) => RunInput | void | Promise<RunInput | void>;

  'before:model'?: (
    ctx: AgentContext,
    messages: readonly Message[],
  ) => Message[] | Promise<Message[]>;

  'after:model'?: (
    ctx: AgentContext,
    messages: readonly Message[],
    usage: Usage,
  ) => void | Promise<void>;

  'before:tool'?: (
    ctx: AgentContext,
    call: ToolUseBlock,
  ) => BeforeToolResult | void | Promise<BeforeToolResult | void>;

  'after:tool'?: (
    ctx: AgentContext,
    call: ToolUseBlock,
    result: ToolResultBlock,
  ) => void | Promise<void>;

  'after:turn'?: (
    ctx: AgentContext,
    messages: readonly Message[],
  ) => void | Promise<void>;

  'before:stop'?: (
    ctx: AgentContext,
    messages: readonly Message[],
  ) => StopDecision | void | Promise<StopDecision | void>;
}
```

### 5.1 Hook 不变量

1. Hooks 按注册顺序执行。
2. `before:run`、`before:model` 是 transformer；后一个 hook 看到前一个的输出。
3. `after:model`、`after:tool`、`after:turn` 是 observer，不替换消息流。
4. `before:tool` 必须保留 `skip`、`input`、synthetic `result` 和 `isError` 能力。
5. `before:stop` 必须受 `maxForceContinues` 限制。
6. 迁移期不改变旧 dispatcher 的 hook error policy；若要改变，另开设计决策。

```ts
export interface BeforeToolResult {
  skip?: boolean;
  input?: unknown;
  result?: string;
  isError?: boolean;
}
```

## 6. RunState / typed context

引擎保持 monomorphic。per-run 数据通过 typed keys 传递，不把业务类型参数横穿 Agent runtime。

```ts
export interface ContextKey<T> {
  readonly name: string;
}

export interface RunState {
  get<T>(key: ContextKey<T>): T | undefined;
  set<T>(key: ContextKey<T>, value: T): void;
  has<T>(key: ContextKey<T>): boolean;
  delete<T>(key: ContextKey<T>): void;
  clear(): void;
}
```

迁移期间可以复用 `ContextStore` 命名和实现；`ContextStore → RunState` 的最终 rename 延后到 cleanup，不能在生命周期迁移期间混入。

要求：

- Agent 每次 run 开始设置当前 RunState。
- Agent 每次 run 结束清理当前 RunState。
- Conversation context、cron、loop 等业务数据不得烤进 per-session system prompt。
- 无 conversation context 的 cron/loop run 必须正常运行，缺席返回 `undefined`。

## 7. SessionManager / persistence

```ts
export interface SessionManager {
  create(config: AgentConfig): Agent;
  open(sessionId: string, config: AgentConfig): Agent;
  get(sessionId: string): Agent | undefined;
  dispose(sessionId: string): void;
}
```

Manager 负责：

- 生成 sessionId。
- 创建并注入 persistence adapter。
- 管理 live Agent Map。
- 在 `open()` 的 memory miss 情况下复用已有持久化状态。
- 统一注入 span start callback。

Caller 不负责：

- 生成技术 sessionId。
- 拼接业务 ID。
- 创建 Checkpointer/SessionStore。
- 直接写 checkpoint 表。

## 8. Agent SDK assembly host

`packages/agent` owns the generic Agent assembly capability. The public entry point is `createAgentSession()`. Current extensions are existing static `Plugin` instances; do not introduce a second `AgentExtensionFactory` layer for ordinary plugins.

```ts
export interface CreateAgentSessionInput {
  model: ChatModel | ModelRef;
  modelRuntime?: ModelRuntime;
  plugins?: readonly Plugin[];
  tools?: readonly Tool[];
  sessionManager?: SessionManager;
  sessionId?: string;
  contextManager?: ContextPipeline;
  systemPrompt?: string;
}

export async function createAgentSession(
  input: CreateAgentSessionInput,
): Promise<Agent>;
```

The SDK must:

- resolve a `ModelRef` through `ModelRuntime`;
- combine base tools with plugin tools;
- preserve Plugin hook execution order;
- reject tool collisions;
- inject SessionManager/persistence and runtime options;
- create the final Agent.

The SDK must not depend on backend `Services`, `SettingsService`, `ConversationPort`, Elysia, React or backend database types.

Backend callers provide concrete Plugin instances and their options. Backend must not build a second generic hook/tool/prompt composer.

## 9. Backend product extension (deferred)

The previous `Capability → AgentExtension → Registry` path is not part of the current Agent runtime path. Ordinary Agent features remain static Plugins.

Only a future cross-boundary product feature may introduce a higher-level `Capability` that combines a Plugin with backend services, routes/commands or surface metadata. Such a Capability must eventually produce a Plugin or runtime registration through the SDK; it must not duplicate the SDK composer.

## 10. Future Pi-style Extension

If dynamic extensions are needed later, define a separate `ExtensionRuntime`:

```ts
export type Extension = (
  runtime: ExtensionRuntime,
) => void | Promise<void>;
```

The future loader may use `jiti` and expose `runtime.registerTool()`, `runtime.on()`, `runtime.registerCommand()` and resource APIs. This is explicitly deferred; no jiti, discovery or reload is part of the current migration.

### Backend infrastructure

Backend creates and owns process-level infrastructure:

```text
ModelRegistry
Settings storage/service
AgentFs
SseBus
database ports
```

Plugins receive only their options. A future Capability owns product services and receives narrow dependencies; do not introduce a broad Service Locator for ordinary Plugin installation.

```text
backend infrastructure
  → Plugin options
  → createAgentSession()
  → Agent
```

### Current limitations

- Plugins must not write Conversation ledger directly.
- Plugins must not control Agent terminal state.
- Plugins must not depend on React; UI slots are deferred.
- Generic hook/tool/prompt composition has one source of truth in `packages/agent`.
- Backend must not create a second Agent composer.

## 9. Phase handoff 规则

每个执行任务必须声明：

```text
Parent plan
Contract version
Prerequisites
Allowed files
Forbidden files
Required behavior
Non-goals
Acceptance commands
Structural checks
Rollback
```

执行 agent 不得：

- 修改本契约。
- 提前实现后续 phase。
- 修改数据库 schema，除非 task 明确授权。
- 用 `any`、宽泛 `as` 或禁用检查绕过边界。
- 将一个失败的 scoped check relabel 为“已有失败”。
