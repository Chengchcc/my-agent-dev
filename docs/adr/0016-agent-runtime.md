# ADR: Agent Runtime 重构

**日期**: 2026-07-22
**状态**: design
**范围**: `packages/agent`（新建）、`packages/framework`（重构）、`packages/harness`（吸收）、`apps/backend`（精简为薄壳）

---

## 问题

### 1. 中间层被架空

```
L3 harness    AgentSession     ← pet/recap/memory 全部挂这层的 subscribe()
L2 framework  createAgent()    ← PluginHooks 只剩 identity/skill/memory 老插件
L1 core       run()            ← 正常运行
```

`framework` 的 `HookContext` 看不到 `modelRegistry` / `settings` / `conversationPort`，所以需要这些能力的 hook 只能绕到 `harness` 层。每加一个新功能都在腐化架构。

### 2. Backend 是 monolithic composition root

`main.ts` 手写所有服务的创建和接线，加一个新功能要改 3 处（插件本身、conversation-compose、main.ts）。Pet/Recap/Memory 的 model 创建逻辑在 conversation-compose 里重复了 3 次。

### 3. 命名暴露实现细节

`Checkpointer`（应该是 `SessionStore`）、`ChatModel`（应该是 `Model`）、`context store`（应该是 `RunState`）——这些名字告诉读者"怎么做的"而不是"做什么的"。

## 决策

### 1. 两层架构

```
旧: harness (AgentSession) → framework (createAgent + PluginHooks) → core (run)
新: agent-runtime (Agent) → core (run)
```

- `AgentSession` 的职责（状态机、steering、retry、compaction）→ `Agent` 类
- `PluginHooks` → 升级为 typed `AgentHooks`（event + handler + return value）
- `Harness` 包 → 撤销，剩余非 Agent 职能（span 管理）留在 backend

### 2. Extension 与 SDK 系统

`packages/agent` 不只是 Agent 生命周期类，还提供通用 Agent SDK。公共入口使用 `createAgentSession()`；`ExtensionHost`、resource loading 和组合器是 SDK 内部/高级实现，不额外暴露一个必须持有的 `AgentSdk` 对象。SDK 负责：

- `createAgentSession()` / Agent factory；
- ExtensionHost；
- hooks、tools、system prompt 的有序组合；
- resource loading boundary；
- SessionManager / persistence 注入；
- AgentConfig 的最终构造。

```text
backend Capability factory
  → AgentExtension
  → packages/agent Agent SDK
  → Agent
```

Capability 是 backend/application 层的产品功能单元，可以贡献 AgentExtension、server routes、commands 和 manifest；通用的 AgentExtension 组合逻辑属于 `packages/agent`，不得在 backend 重复实现。

```typescript
// packages/agent：runtime-neutral extension
interface AgentExtension {
  id: string;
  hooks?: AgentHooks;
  tools?: readonly Tool[];
  systemPrompt?: string;
  resources?: ResourceProvider;
}

// apps/backend：product capability
interface Capability {
  id: string;
  createExtension?: (scope: CapabilityScope) => AgentExtension | Promise<AgentExtension>;
  installServer?: (ctx: CapabilityServerContext) => void | Promise<void>;
  manifest?: CapabilityManifest;
}
```

`packages/agent` 不依赖 `SettingsService`、`ConversationPort`、Elysia、React 或 backend 数据库。Backend 负责创建共享基础设施；Capability factory 负责创建和拥有产品 service；Agent SDK 负责通用 Agent 组装。

### 实施契约说明

本 ADR 的 TypeScript 片段表达目标方向，不是迁移期间可直接执行的完整接口。跨 phase 的具体公共边界、不变量、兼容策略和 handoff 规则以 [`2026-07-23-agent-runtime-contract.md`](../superpowers/specs/2026-07-23-agent-runtime-contract.md) 为准。

具体约束：

- Capability 的 Agent 扩展通过 `AgentExtension` 声明式聚合；不要求 Capability 在构造后任意修改 Agent。
- `agent.emit()` 不作为外部任意事件写入口；外部只订阅 Agent 事件，业务事件通过受控 hook/context/projection 边界产生。
- `steering` 和 `followUp` 在迁移期保持现有独立语义，不能直接合并成一个未定义的 `interrupt(input)` API。
- `slots` 第一阶段只保存 slot 标识，不携带 React 组件类型。

**约定位置（Slot）：**

| Slot | 位置 |
|------|------|
| `conversation:sidebar` | 对话区域右侧 |
| `conversation:composer-before` | 输入框左侧 |
| `agent-detail:tab` | Agent 详情页标签 |
| `settings:section` | Settings 页面卡片 |

### 3. Services 接口

Agent 不直接依赖外部系统。Capability 通过 `Services` 注入外部能力：

```typescript
interface Services {
  modelRegistry: ModelRegistry;
  settings: SettingsService;
  sse: SseBus;
  fs: AgentFs;
  ledgerPort?: ConversationPort;
}
```

### 4. 命名对齐

| 旧 | 新 | 理由 |
|----|-----|------|
| `createAgent()` | `Agent` 类 | 工厂函数 → 一等对象 |
| `PluginHooks` | `AgentHooks` | 明确归属 |
| `HookContext` | `AgentContext` | 上下文是谁的 |
| `AgentSession` | 并入 `Agent` | 一个 Agent 一个实体 |
| `SessionConfig` | `AgentConfig` | session 概念太重 |
| `ChatModel` | `Model`（ai 包已有） | chat 是用法 |
| `Checkpointer` | `SessionStore` | 不暴露实现 |
| `ContextManager` | `ContextPipeline` | 管道，非管理者 |
| `context store` | `RunState` | key-value 的具体用途 |
| `steering / followUp` | `agent.interrupt(input)` | 单一语义 |

### 5. 包结构

```
旧:
@my-agent-team/ai
@my-agent-team/core
@my-agent-team/framework
@my-agent-team/harness

新:
@my-agent-team/ai               ← 不变
@my-agent-team/core             ← 不变
@my-agent-team/agent            ← framework + harness 合并
```

### 6. Agent Hooks 设计

```typescript
interface AgentHooks {
  "before:run":    (ctx: AgentContext) => void;
  "before:model":  (ctx: AgentContext, msgs: Message[]) => Message[];
  "after:model":   (ctx: AgentContext, msgs: Message[], usage: Usage) => void;
  "before:tool":   (ctx: AgentContext, call: ToolCall) => { skip?: boolean; input?: unknown };
  "after:tool":    (ctx: AgentContext, call: ToolCall, result: ToolResult) => void;
  "after:turn":    (ctx: AgentContext, msgs: Message[]) => void;
  "before:stop":   (ctx: AgentContext, msgs: Message[]) => { continue: boolean; reason: string };
}
```

Agent 暴露 `agent.on(event, handler)` / `agent.emit(event, payload)`。

### 改动范围

| 当前 | 目标 |
|------|------|
| `packages/framework` | → `packages/agent` |
| `packages/harness` | → 核心并入 `agent`，其余留在 backend |
| `apps/backend/main.ts` | → 薄启动层，调用 `backend.install(...)` |
| `conversation-compose.ts` | → Agent 生命周期壳，capability 注入 |
| `plugin-pet/recap/memory` | → Capability 函数，挂 `agent.on(...)` |

### 不做

- Pi 的 30+ 细粒度事件 — 只实现我们需要的 7 个
- `before_provider_request` — 先不加，有 demand 再加
- Extension runtime / jiti loader — 先静态 import，后续按需动态加载
- 前端 slot 动态渲染 — Capability 的 slots 字段先定义，前端静态渲染

## 实现顺序

1. Agent 类 (`packages/agent`) — 合并 framework + harness
2. AgentHooks 升级 — typed events + return values
3. Services 接口 — modelRegistry / settings / sse / fs
4. Backend 精简 — 薄启动层 + backend.install()
5. pet/recap/memory 迁移到 Capability 模式
6. 命名对齐全量更新

---

## 目标架构

```
┌──────────────────────────────────────────────────────┐
│ Application / Surfaces                                │
│ Backend HTTP · Web · Lark · CLI                       │
└──────────────────────┬───────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────┐
│ Orchestration                                          │
│ Workflow · Agent Team · Sub-agent · Feedback Loop      │
│ apps/backend + packages/loop                           │
└──────────────────────┬───────────────────────────────┘
                       │ createAgentSession()
┌──────────────────────▼───────────────────────────────┐
│ Agent SDK / Runtime                                    │
│ Agent · ExtensionHost · ResourceLoader                 │
│ Hook composer · Tool composer · SessionManager          │
│ packages/agent                                         │
└──────────────┬──────────────┬──────────────┬───────────┘
               │              │              │
        ┌──────▼─────┐ ┌──────▼─────┐ ┌──────▼────────┐
        │ Model       │ │ Tools      │ │ Context        │
        │ Provider    │ │ Built-in   │ │ Prompt         │
        │ packages/ai │ │ MCP        │ │ Compressor     │
        │             │ │ Conversation│ │ RunState       │
        └─────────────┘ └────────────┘ └───────────────┘
                       │
┌──────────────────────▼────────────────────────────────┐
│ Persistence / Events                                   │
│ SessionStore · RunEventLog · Message · Conversation     │
└────────────────────────────────────────────────────────┘

Cross-cutting:
Tracing · Debugging · Evals · Metrics
```

### 当前实现状态 (2026-07-24)

| 组件 | 位置 | 状态 |
|------|------|------|
| `Agent` 生命周期类 | `packages/agent/src/agent.ts` | ✅ P0-P4R |
| `AgentHooks` (typed) | `packages/agent/src/agent-hooks.ts` | ✅ |
| `createAgentSession()` | `packages/agent/src/agent-sdk.ts` | ✅ P6-C |
| `ExtensionHost` / compositors | `packages/agent/src/extension-host.ts` | ✅ P6-C |
| `ModelRuntime` port | `packages/agent/src/model-runtime.ts` | ✅ P6-C |
| `SessionManager` / `SqliteSessionManager` | `packages/agent/src/session-manager.ts` | ✅ P3 |
| `CapabilityRegistry` (thin catalog) | `apps/backend/src/capabilities/registry.ts` | ✅ P6 |
| `BackendInfrastructure` / deps | `apps/backend/src/capabilities/types.ts` | ✅ P6-B |
| Capability wrappers (identity, skill, ...) | `apps/backend/src/capabilities/` | ⏳ P7 |
| Conversation production wiring | `apps/backend/src/features/conversation/` | ⏳ P7 |
| Naming migration (Checkpointer→SessionStore, ...) | — | ⏳ P10 |
| Framework / harness deletion | — | ⏳ P11 |
