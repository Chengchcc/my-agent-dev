---
id: execution.agent-backend
title: Agent Backend
status: design
owners: architecture
summary: "Agent Backend 是执行 Agent Run 的可替换引擎。Product Backend 传入 Run snapshot 和 Agent Context，Backend 返回 Live Updates 与唯一 outcome。"
depends_on:
  - agents.context
used_by:
  - architecture.system-overview
  - backend.overview
  - flows.e2e-web-message
---

# Agent Backend

Agent Backend 的目标是让 Product Backend 不依赖某个具体执行引擎。Claude Code、Codex、OpenCode 和 Coding Agent 都能执行同一种 Agent Run，同时保留各自的 session、模型循环、工具、compaction、retry 和 sub-agent。

```text
Agent Run
  → Agent Backend
      → Live Updates
      → BackendRunOutcome
```

Product Backend 只依赖统一协议，不读取 Backend 内部 transcript 或 session。Adapter、transport 和 event mapper 是各 Backend 的内部实现。

## Agent Backend 协议

```ts
interface AgentBackend {
  readonly kind: string;
  readonly capabilities: AgentBackendCapabilities;

  start(input: BackendStartInput): Promise<BackendSessionRun>;

  send(
    session: BackendSessionHandle,
    input: BackendRunInput,
  ): Promise<BackendRunSegment>;

  resume(
    backendSessionId: string,
    input: BackendStartInput,
  ): Promise<BackendSessionRun>;

  respond(
    session: BackendSessionHandle,
    action: PendingActionResponse,
  ): Promise<BackendRunSegment>;

  stop(session: BackendSessionHandle): Promise<void>;
  close(session: BackendSessionHandle): Promise<void>;
}

interface BackendSessionRun {
  session: BackendSessionHandle;
  segment: BackendRunSegment;
}
```

`BackendSessionHandle` 是 adapter-private live handle。Product Backend 只能读取 opaque `backendSessionId`、backend kind 和生命状态，不能读取或修改 Runtime 内部 transcript。`start()` 与 `resume()` 必须同时返回 handle 和首个 run segment，避免冷启动后还要再调用一次 `send()` 才开始执行。

本文接口片段中的辅助类型含义如下：

- `WorkspaceBinding`：Runtime 可访问的工作目录及其权限边界；
- `ProductToolDescriptor`：Product Tool 的名称、说明、输入 schema 和调用入口；
- `Usage`：统一 token/cost 统计，字段缺失时允许为空；
- `PendingAction`：等待用户或产品控制面响应的审批、问答或权限请求；
- `PendingActionResponse`：用户或产品控制面对指定 action 的结构化响应，必须携带 `actionId` 以保证幂等。

## 一次 Agent Run 需要哪些输入

### 新建或恢复 session

```ts
interface ProjectedHistoryItem {
  productEntryId: string;
  message: Message;
}

interface BackendStartInput {
  history: readonly ProjectedHistoryItem[];
  run: AgentRunSnapshot;
  workspace: WorkspaceBinding;
  env?: Record<string, string>;
  metadata: {
    conversationId: string;
    agentMemberId: string;
    branchId: string;
    productRevision: number;
  };
}
```

### 复用 session 执行 Agent Run

```ts
interface AgentRunSnapshot {
  runId: string;
  model: BackendModelRef;
  systemPrompt?: string;
  productTools: readonly ProductToolDescriptor[];
  configRevision: number;
}

interface BackendRunInput {
  messages: readonly ProjectedHistoryItem[];
  run: AgentRunSnapshot;
  mode: "normal" | "steer" | "follow_up";
  metadata: {
    branchId: string;
    throughEntryId?: string;
    productRevision: number;
  };
}
```

`AgentRunSnapshot` 在 Agent Run 开始时固定。复用 execution session 时，`send()` 仍必须接收它，因此 model、SOUL/Memory/Skill 生成的 System Prompt 和 Product Tool manifest 可在下一个 Agent Run 生效，而不要求无条件重建 session。

Product Backend 决定发送哪些语义历史；Adapter 不自行从 Conversation History 取消息，也不改变 Agent Context。

`productEntryId` 是 Agent Context entry 的稳定身份。Adapter 必须保留并传给 Runtime，用于幂等增量同步；它不是 Runtime message ID，也不能由 Runtime 重新生成。

## BackendRunOutcome

```ts
interface BackendRunSegment {
  events: AsyncIterable<BackendEvent>;
  outcome: Promise<BackendRunOutcome>;
  stop(): Promise<void>;
}

type BackendRunOutcome =
  | { status: "completed"; output?: Message; usage?: Usage }
  | { status: "suspended"; pendingAction: PendingAction; usage?: Usage }
  | { status: "failed" | "aborted" | "timeout"; error?: string; usage?: Usage };
```

`completed`、`failed`、`aborted` 和 `timeout` 是 Agent Run 终态。`suspended` 只是一个 run segment 的非终态结果；Product Backend 持久化 `PendingAction`，保留 branch lock 和 active run identity，不提交最终 assistant Message，也不推进 follow-up。

用户响应后，Product Backend 继续同一个 Agent Run，并把 response 交给支持 continuation 的 Backend。同一个 `actionId` 只能消费一次；只有后续 outcome 为终态，Agent Run 才结束。

如果 Backend 不支持 `pendingActionResponse`，审批必须在 Product Tool 调用完成前同步解决；Backend 不能返回无法继续的 `suspended`。Product Backend 不能根据静默、最后一段文本或 tool event 猜测完成。

## Product Backend 可以依赖哪些事件

Product Backend 对外维护稳定的小型核心事件集，例如：

```text
text_delta
thinking_delta
product_tool_started
product_tool_completed
native_tool_started
native_tool_completed
pending_action
status
turn_completed
turn_failed
```

Adapter 只映射 Runtime 真正支持的事件。Runtime 特有信息使用：

```text
backend.claude.*
backend.codex.*
backend.opencode.*
backend.coding_agent.*
```

Namespaced extension 可用于诊断或增强 UI，但 Product 业务状态机不能依赖它。

## Backend capabilities

```ts
interface AgentBackendCapabilities {
  persistentSession: boolean;
  nativeResume: boolean;
  nativeSteer: boolean;
  thinkingStream: boolean;
  productTools: "mcp" | "native" | "unsupported";
  pendingActionResponse: boolean;
}
```

缺失能力必须显式 fallback 或返回 unsupported，不能由 Adapter 伪装不存在的语义。

### Steer 和 follow-up

Product Backend 始终维护两类队列：

- `steer`：希望尽快影响当前工作；
- `follow-up`：等待当前工作自然结束后处理。

如果 Backend 声明 `nativeSteer`，Agent Run coordinator 可以立即转发；否则 steer 在安全 run boundary 作为下一输入。Follow-up 始终由 Product Backend 排队。

## Agent Run 的并发与 session cache

同一 Context Branch 最多一个 active Agent Run。Normal、steer 和 follow-up 先进入持久队列；只有 Backend 明确 accept 后才标记 delivered。

Product Backend 可以在内部缓存 Backend 的 live handle，以加速连续 Run。这个 cache 不是产品事实：丢失后可从 Agent Context 重建，且不能覆盖 Context。

## Execution session 丢失后如何恢复

只有 Backend kind、Context Branch、同步 entry 和 product revision 全部匹配时才尝试原生 resume。任一不匹配都从 Agent Context 当前 branch 生成 `ProjectedHistoryItem[]`，调用 `start()` 建立新 execution session。

## Context Branch 如何选择 Backend

每个 Context Branch 固定一个 Agent Backend。Fork 默认继承，也允许新 branch 显式选择另一个 Backend。新的 branch 不继承旧 live session；Backend 内部可以透明使用原生 fork，但产品正确性始终依赖 Agent Context 重建。

## 工具由谁执行

### Backend 自带工具

Claude Code、Codex、OpenCode 和 Coding Agent 各自执行文件、Shell、搜索、浏览器和原生 MCP 工具。Product Backend 只接收标准化观测事件，不统一其私有输入输出协议。

### Product Tools

Conversation、Task、Memory、Artifact、审批、History 等 Product Tools 由 Product Backend 统一实现。Backend 可以通过 MCP 或自己的原生 tool protocol 调用，但 transport 不改变 Tool 的权限和事实 ownership。

Product Tool 的权限、身份、审计和幂等性属于 Product Backend。只有语义相关的 call/result 才写 Agent Context。

## Coding Agent 如何接入

自研引擎是 `CodingAgentBackend`，与 Claude Code、Codex、OpenCode 并列。其内部可以包含 Plugin、ContextPipeline、model loop、native tools、retry 和内部 compaction，但不能把私有 session 当作产品历史事实。

自研 Backend 每次从 Context Branch 的线性语义历史开始或增量同步，输出统一 events/result。它是优秀 Runtime 的学习者和可替换实现，不是 Product Backend 的内核依赖。

## 不变量

1. Product Backend 只依赖 Agent Backend 接口。
2. Execution session ID 是 opaque cache key，不是产品实体 ID。
3. 同一 Context Branch 最多一个 active run。
4. Terminal `BackendRunOutcome` 是 Agent Run 终态唯一来源。
5. Capability 缺失必须显式处理。
6. Runtime 原生工具留在 Runtime；产品工具由 Product Backend 统一执行。
7. AgentBackend 不直接写 Conversation History 或 Agent Context。
8. CodingAgentBackend 与外部 Runtime 遵守同一协议。

## 关联页面

- [系统总览](../system-overview.md)
- [Agent Context](../agents/context.md)
- [后端总览](../backend/overview.md)
- [Conversation History](../conversation/history.md)
- [Web 消息端到端](../flows/e2e-web-message.md)
