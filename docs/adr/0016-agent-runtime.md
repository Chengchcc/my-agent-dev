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

### 2. Agent SDK 与 Plugin 系统

`packages/agent` 不只是 Agent 生命周期类，还提供通用 Agent SDK。公共入口是 `createAgentSession()`，负责：

- ModelRuntime / ModelRef 解析边界；
- Plugin、tools、system prompt 的组装；
- hook 执行顺序与 tool collision 校验；
- SessionManager / persistence 注入；
- AgentConfig 构造和 Agent 创建。

```text
backend 提供 model/tools/plugins
  → packages/agent.createAgentSession()
  → Agent
```

当前采用 **Plugin-first**：现有功能直接以 `Plugin` 形式接入 Agent SDK。普通 Agent 扩展不再额外包装成 Capability。

```typescript
// packages/agent
interface CreateAgentSessionInput {
  model: ChatModel | ModelRef;
  modelRuntime?: ModelRuntime;
  plugins?: readonly Plugin[];
  tools?: readonly Tool[];
  sessionManager?: SessionManager;
  sessionId?: string;
}
```

`identityPlugin`、`progressiveSkillPlugin`、`conversationContextPlugin`、`todoPlugin`、`goalPlugin`、`petPlugin`、`recapPlugin` 和 `memoryPlugin` 当前都保持 Plugin 形态。Backend 负责提供它们所需的业务参数，但不实现第二套通用 Agent composer。

### 3. Capability：已删除

此前设计的 backend `Capability → AgentExtension → Registry` 链路已在 P8 删除。它会把普通 Plugin 的安装增加多层包装，重复 Agent SDK 的组装职责。

当前不保留 Capability wrapper。未来若有跨 runtime/backend/surface 的产品功能，基于当时需求重新设计；不预留 Capability 类型或 wrapper。

### 4. Future Pi-style Extension

如果未来需要类似 Pi 的动态扩展，再单独设计 `ExtensionRuntime`：

```typescript
type Extension = (runtime: ExtensionRuntime) => void | Promise<void>;
```

未来 Extension 可以通过 `jiti` 静态/动态加载，并使用 runtime 注册：

```text
jiti loader
  → extension(runtime)
  → runtime.registerTool()
  → runtime.on()
  → runtime.registerCommand()
```

这不属于当前 runtime migration。不引入 jiti、动态发现、reload 或 extension package loader。

### 实施契约说明

本 ADR 的 TypeScript 片段表达目标方向，不是迁移期间可直接执行的完整接口。跨 phase 的具体公共边界、不变量、兼容策略和 handoff 规则以 [`2026-07-23-agent-runtime-contract.md`](../superpowers/specs/2026-07-23-agent-runtime-contract.md) 为准。

具体约束：

- Plugin 是当前 Agent runtime 的唯一扩展机制。
- `createAgentSession()` 是 Agent 组装的唯一公共入口。
- Backend 不重复实现 hook/tool/prompt composer。
- Capability registry 和 AgentExtension runtime 已在 P8 删除；当前代码不保留。
- 不预留 Capability 类型或 registry；当前所有功能通过 Plugin 接入。
- `agent.emit()` 不作为外部任意事件写入口；外部只订阅 Agent 事件，业务事件通过受控 hook/context/projection 边界产生。
- `steering` 和 `followUp` 在迁移期保持现有独立语义，不能直接合并成一个未定义的 `interrupt(input)` API。
- slots 和 jiti Extension 属于未来设计，不进入当前 runtime migration。


### 3. Services 接口

Agent 不直接依赖外部系统。Backend 负责创建共享基础设施；Plugin 的 options 由 backend 组装并传入 `createAgentSession()`。

通用 Agent SDK 不依赖 `SettingsService`、`ConversationPort`、Elysia、React 或 backend 数据库。

### 4. 命名对齐

| 旧 | 新 | 理由 |
|----|-----|------|
| `createAgent()` | `Agent` 类 | 工厂函数 → 一等对象 |
| `PluginHooks` | `AgentHooks` | 明确归属 |
| `HookContext` | `AgentContext` | 上下文是谁的 |
| `AgentSession` | 并入 `Agent` | 一个 Agent 一个实体 |
| `SessionConfig` | `AgentConfig` | ✅ P10-1 |
| `ChatModel` | 保留 | `Model` 是 provider metadata，已存在不同概念 |
| `Checkpointer` | `MessageStore` + `EventLog` + `InterruptStore` | ✅ P10-4 公共 API 已移除；内部吸附待 P11 |
| `ContextManager` | `ContextPipeline` | ✅ P10-3 agent 公共 API |
| `ContextStore` | `RunState` | ✅ P10-2 唯一公共类型 |
| `steering / followUp` | 保留独立语义 | 不是同一 interrupt(input) |

### 5. 包结构

```text
旧:
@my-agent-team/ai
@my-agent-team/core
@my-agent-team/framework
@my-agent-team/harness

新:
@my-agent-team/ai               ← provider/model runtime
@my-agent-team/core             ← protocol + run
@my-agent-team/agent            ← Agent + SDK + Plugin assembly
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

Agent 暴露 `agent.on(event, handler)`；不把任意 `agent.emit(event, payload)` 作为外部写入口。

### 改动范围

| 当前 | 目标 |
|------|------|
| `packages/framework` | → `packages/agent` 内部实现，最终删除 |
| `packages/harness` | → 核心并入 `agent`，最终删除 |
| `apps/backend/main.ts` | → 薄启动层，调用 SDK/feature installers |
| `conversation-compose.ts` | → Agent 生命周期壳，调用 `createAgentSession()` |
| `packages/plugin-*` | → 继续作为静态 Plugin，逐个迁移到 SDK入口 |
| `apps/backend/src/capabilities` | → 已删除 (P8) |

### 不做

- Pi 的 30+ 细粒度事件 — 只实现我们需要的事件。
- `before_provider_request` — 先不加，有 demand 再加。
- jiti/dynamic extension loader — 延后到未来独立 phase。
- 前端 slot 动态渲染 — 当前不做。

## 实现顺序

1. Agent 类 (`packages/agent`) — 合并 framework + harness runtime 能力。
2. AgentHooks 与 `createAgentSession()` — typed hooks、ModelRuntime、Plugin assembly。
3. Backend caller adoption — Conversation/Cron/Loop/Skill Pack 使用 SDK入口。
4. Plugin-first production migration — 继续接入现有静态 Plugin，不引入 Capability wrapper。
5. Backend assembly cleanup — 去除重复 plugin/model/context 组装。
6. Naming migration — Checkpointer/ContextStore/ContextManager 等逐项重命名。
7. 删除 framework/harness。

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
│ Agent · createAgentSession() · SessionManager          │
│ Plugin dispatch · ModelRuntime · persistence boundary    │
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
| `createAgentSession()` | `packages/agent/src/agent-sdk.ts` | ✅ P7 |
| `ModelRuntime` port | `packages/agent/src/model-runtime.ts` | ✅ P6-C |
| `SessionManager` / `SqliteSessionManager` | `packages/agent/src/session-manager.ts` | ✅ P3 |
| Plugin-first production migration | `apps/backend/src/features/` | ✅ P7 |
| Capability/AgentExtension runtime | — | ❌ 已删除 (P8) |
| Backend assembly cleanup | `apps/backend/src/` | ✅ P8 |
| Backend bootstrap cleanup | `apps/backend/src/` | ✅ P9 |
| Naming migration (`Checkpointer` → `SessionStore`, ...) | — | ⏳ P10 |
| Framework / harness deletion | — | ⏳ P11 |
