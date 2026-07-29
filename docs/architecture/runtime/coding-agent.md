---
id: runtime.coding-agent
title: Coding Agent
status: design
owners: architecture
summary: "Coding Agent 是无 UI 的独立 Coding Agent 服务，对标 Pi Coding Agent 的 session、model loop、工具、Plugin、skill、compaction 与事件能力。它通过 CodingAgentBackend 接入 Product Backend，与 Claude Code、Codex、OpenCode 保持并列。"
depends_on:
  - execution.agent-backend
used_by:
  - runtime.coding-agent-session
  - runtime.coding-agent-prompt
  - runtime.coding-agent-models
---

# Coding Agent

Coding Agent 是本项目自研的 Agent 执行引擎。它不是 Product Backend 的内部模块，而是一个独立 Daemon，通过 `CodingAgentBackend` Adapter 遵守与 Claude Code、Codex、OpenCode 相同的 AgentBackend 协议。

它的定位是**无 UI 的 Coding Runtime**：具备持久 session、模型与工具循环、Plugin、Skill、Context、Compaction、Retry、Steer/Follow-up 和运行事件，但不包含 TUI、Web、Lark、Conversation、Task、Cron、Loop 或 Agent Context。

## Runtime 如何部署

Daemon 使用 per-session Worker 隔离故障和资源：

```text
Product Backend
  → CodingAgentBackend
      → HTTP commands + SSE events
          → Coding Agent Daemon
              → CodingSessionSupervisor
                  → Session Worker Process A
                  → Session Worker Process B
                  → Session Worker Process C
```

每个 live Coding Session 使用独立 Worker 子进程。Daemon 负责 session 定位、启动限流、sleep/wake、crash recovery 和 worker 生命周期。一个 worker 崩溃只影响对应 session。

Product Backend 与 Daemon 使用内部 service credential。Daemon 是单租户信任边界：一个 Daemon deployment 服务一个 Product Backend deployment，共享一套 Provider CredentialStore。

## Product Backend 如何调用 Runtime

Daemon 使用 HTTP mutation commands + SSE event stream。首版只固定语义操作：

```text
create/open session
start loop
steer
stop
compact
close session
subscribe events
```

具体 URL、错误码和 replay window 属于 transport spec，不作为核心架构概念。Mutation 带 `idempotencyKey`；SSE 事件带单调 event ID 并支持断线重连。完整恢复依赖 Coding Session Store，不依赖 SSE。
## 核心概念

### CodingSessionSupervisor：管理 Worker 生命周期

负责：

- 创建、打开、sleep、wake 和关闭 Coding Session；
- 每个 live session 启动独立 Worker；
- 保证同一 session 最多一个 active Agent Loop；
- worker crash 后从 SessionStore 恢复；
- 限制并发 worker 启动，避免资源峰值。

### Coding Session：可恢复的执行缓存

一个持久执行缓存。它拥有 append-only Coding Session Tree、active leaf、当前 active Agent Loop 和 Runtime-local todo。它不拥有 Context Branch；Context Branch 只是它的上游 canonical source。

### Agent Loop：一次 Coding Agent 自治循环

Agent Run 是 Product Backend 的持久执行身份，可以包含 waiting continuation 或 terminal commit recovery。Coding Agent Adapter 在没有 waiting continuation 时，通常把一个 Agent Run 映射为一个 Agent Loop；这个映射不是 Agent Backend 的通用语义。

```text
Agent Run
  → Coding Agent Loop
      → N Model Turns
```

每个 Model Turn 是一次模型响应以及随后的工具执行。Provider retry 属于同一个 Agent Loop，不重复写入 loop input。

### ModelRuntime：调用模型

Daemon 内的 Provider + ModelRuntime 服务负责模型目录、凭证、auth refresh、模型解析和 stream dispatch。模型调用在 Session Worker 内执行；Product Backend 只传 `BackendModelRef`，不接触 provider secrets。

### Plugin：扩展循环行为

Session 启动时静态装载 Plugin manifest。Plugin 首版只贡献 hooks、tools 和 meta section provider；Todo 使用内置 `TodoStateEntry`。只有出现第二个 durable plugin-state 用例时才抽象通用 entry extension。Plugin 不控制 Agent Context、Agent Run terminal 或 AgentBackend 协议。

## 哪些数据属于 Product Backend

```text
Agent Context = canonical product context
Coding Session Tree = derived execution cache
```

Coding Agent Session 可丢失、可从 Context Branch 投影重建。Coding Session Tree 永远不能反向覆盖 Agent Context。

每个 Agent Loop 开始时，Adapter 根据 execution session state 同步点传入新增语义 history 和 `AgentRunSnapshot`。Runtime 以 `productEntryId` 幂等追加，然后写本轮 Meta User Message 和真实 Prompt。

## Runtime 自带哪些工具

### Coding Core

```text
read
write
edit
bash
grep
glob
```

### Web

```text
web_search
web_fetch
```

Runtime core 只依赖 `WebSearch` / `WebFetch` ports；宿主注入具体搜索供应商、代理和鉴权实现。

### Misc

```text
todo
skill_load
```

Todo 和 Skill 是 Runtime-local helper：

- Todo 通过内置 `TodoStateEntry` 持久化；
- Skill 由 Adapter 传入 roots manifest，Runtime 扫描 `SKILL.md` frontmatter；
- Meta User Message 只注入 skill index，正文通过 `skill_load` 渐进加载；
- Product Task 和 Product Skill Pack 操作仍通过 Product MCP。

### MCP

MCP 工具动态加入 Runtime 工具表。Product Tools 也通过 MCP 优先接入，但在工具 metadata、权限和事件中标记为 `product`。

## Agent Loop 何时停止或失败

停止规则：

```text
模型自然停止
+ maxSteps
+ beforeStop 有限 veto
+ maxForceContinues
+ tool terminate hint
```

Retry 只处理 provider transient error：network、rate limit、overload、5xx。Tool/business error 转成 tool result，由模型决定后续。Context overflow 走 compaction recovery，并最多自动重试一次。

## 上下文过大时如何压缩

Runtime compaction 支持：

```text
threshold proactive compaction
overflow recovery compaction
manual compaction
```

Compaction 写 Runtime `CompactionEntry`，不写 Agent Context。它是 Execution session cache 优化；Product Summary 是另一套由 Product Backend 管理的跨 Runtime 语义事实。

## Runtime 会发出哪些事件

Runtime 发 Pi-style typed lifecycle events：

```text
agent_start / agent_end
turn_start / turn_end
message_start / message_update / message_end
tool_execution_start / update / end
retry_start / retry_end
compaction_start / compaction_end
queue_update
```

Listener Promise 按注册顺序等待。`agent_end` listener 全部完成后，Agent Loop 才 settled。CodingAgentBackend 将这些事件映射为 Product Backend 稳定核心事件。

## 凭证与 Workspace 如何隔离

- Provider credentials 仅由 Daemon CredentialStore 持有；
- Credential 不进入 Session Tree、event payload 或日志；
- 每个 worker 只继承当前模型与工具所需的最小环境；
- Workspace 必须在 Daemon allowlisted roots 中；
- Session ID 必须经过格式校验，不能拼接成任意文件路径；
- Session 文件、worker 和日志按 session 隔离；
- 单租户不代表无隔离：session 之间仍不能读取彼此的 workspace 或 store。

## 为什么首版不恢复 waiting loop

Coding Agent 首版不承诺 worker crash 后恢复同一个 waiting Agent Loop。需要人工审批或问答的 Product Tool 通过 MCP 同步等待：worker 活着时 MCP 请求阻塞至 Product Backend 返回响应；worker crash 时当前 Agent Run 失败，由 Product Backend 从 Agent Context 发起新 Agent Run。

因此 CodingAgentBackend 首版声明 `pendingActionResponse: false`，不实现 `respond` command，也不使用 Agent Backend 的 durable `respond()` continuation。出现必须跨 worker 恢复同一审批点的真实需求时，再设计 ActiveLoop/PendingAction checkpoint；首版不预留该状态模型。

## 不变量

1. Coding Agent 是 Agent Backend 实现，不是 Product Backend 内核。
2. 每个 live Coding Session 一个 worker 子进程。
3. Coding Session Tree 是可重建 cache，不是 Product history。
4. 同一 Coding Session 最多一个 active Agent Loop。
5. 一个 Agent Loop 只有一份 input snapshot，retry 不重复写入。
6. System Prompt 与 Meta Message 由 Adapter 构建并通过 AgentRunSnapshot 传入。
7. Provider secrets 只存在 Daemon trust boundary。
8. Plugin 静态装载，Runtime 不实现动态代码发现/reload。
9. Listener settlement 是 Agent Loop settlement 的一部分。
10. Runtime-specific能力不泄漏进 Product Backend 核心协议。

## 关联页面

- [Agent Backend](../execution/agent-backend.md)
- [Coding Agent Session](./coding-agent-session.md)
- [Coding Agent Prompt 与 Context](./coding-agent-prompt.md)
- [Coding Agent Provider 与 ModelRuntime](./coding-agent-models.md)
- [Agent Context](../agents/context.md)
