---
id: architecture.system-overview
title: 系统总览
status: current
owners: architecture
last_verified_against_code: 2026-07-28
summary: "整个系统是一个「团队 Agent」运行时：端负责输入与渲染，后端持有事实并直接在进程内通过 Agent 驱动执行。assistant 消息经 onEvent 回调直写 conversation ledger，非消息执行事件经 agent runtime (span-loop) 写 persistence ports 的执行事实流（按 spanId）。conversation ledger SSE 是用户可见输出的唯一通道。"
depends_on:
  - foundations.facts-and-projections
used_by:
  - flows.e2e-web-message
  - flows.e2e-lark-message
---

# 系统总览

整个系统是一个「团队 Agent」运行时：端负责输入与渲染，后端持有事实并直接在进程内通过 Agent 驱动执行。assistant 消息经 `agent.subscribe` 的 `onEvent` 回调直写 conversation ledger，与人类消息共用同一条 `appendLedgerEntry` 入口。非消息执行事件（tool_start/tool_end/llm_call）经 agent runtime (span-loop) 写入 persistence ports 的执行事实流（`checkpoint_events`，按 spanId 切）。conversation ledger SSE 是用户可见输出的唯一通道。

## 容器视图

```mermaid
flowchart TB
  subgraph Surfaces[端]
    Web[apps/web\nWeb 控制台]
    Lark[apps/lark-bot\n飞书 Bot]
  end

  subgraph Backend[apps/backend]
    API[HTTP/SSE 路由]
    Conv[Conversation Service]
    AG[Agent\nAgent + createAgentSession + plugins + persistence]
    Ops[运行可观测性]
  end

  subgraph Storage[存储]
    BDB[(backend.db\nagents/conversation/member/issue\nledger/run/attempt/control_plane_event)]
    CKPT[(checkpointer.db\nmessages/interrupts\nevents 按 spanId)]
  end

  subgraph Packages[共享包]
    AGP[Agent\nAgent + createAgentSession + plugins + persistence]
    MSG[Message\nMessageRevision 模型]
    CV[Conversation\nLedgerEntry + Member]
  end

  Web <--> API
  Lark <--> API
  API --> Conv
  Conv --> AG
  AG --> AGP
  AGP --> MSG
  Conv --> CV
  Conv --> BDB
  API --> EDB
  AG --> CKPT
  BDB --> Web
  BDB --> Lark
```

## 分层与各自的边界

| 层 | 名字 | 拥有 | 不该拥有 |
|---|---|---|---|
| L1 | Core 原语 | Message / Tool / ChatModel | 后端、端、租户语义 |
| L2 | Agent | Agent 主循环、插件、上下文管理、split persistence | 成员关系、账本 |
| L3 | Backend | agents / conversation / run / ops / ledger | 模型与工具内部 |
| L4 | 端 | Web/飞书的输入与渲染 | 任何持久化事实 |

## 一次完整运行的时序

```mermaid
sequenceDiagram
  participant H as 人
  participant S as 端 (Web/飞书)
  participant B as Backend
  participant AG as Agent
  participant EL as EventLog
  participant L as Conversation Ledger

  H->>S: 发消息
  S->>B: POST 会话消息
  B->>L: 追加人类 MessageRevision
  B->>AG: startAgentRun(input)
  AG->>EL: eventLog.appendEvent(...)
  AG-->>B: onEvent("message", state=streaming)
  B->>L: appendAssistantMessage（直写）
  L-->>S: 会话 SSE -> 按 messageId upsert
  AG-->>B: onEvent("message")（更多轮）
  B->>L: 直写（同 messageId, state=streaming）
  L-->>S: 会话 SSE -> UI 刷新
  AG-->>B: onEvent("agent_end", willRetry=false)
  B->>L: terminal revision（state=done）
  L-->>S: 会话 SSE -> UI 终态
  AG->>EL: span-loop appendEvent（非消息执行事件, 按 spanId）
```

## 关键事实

1. **消息直写账本。** Agent 的 `onEvent("message")` 回调直接 `appendAssistantMessage` 写进账本。直写失败抛出，run 标记 error。
2. **terminal revision 在 `agent_end` 时写入。** assistant 消息从 streaming 到 done/error 是同一 `messageId` 的多次直写。`agent_end`（`willRetry=false`）时写入 state=done/error 关闭消息。
3. **conversation ledger SSE 是用户可见输出的唯一通道。** Web 和飞书统一通过 conversation SSE 接收所有用户可见更新，按 `messageId` upsert。

## 不变量

1. 对话事实与运行事实分属两类，互不充当对方。
2. 端可以展示数据，但不能成为事实来源。
3. Agent 执行、发射事件，不决定对话语义。
4. assistant 消息与人类消息经同一入口（`appendLedgerEntry`）写进账本。账本是对话消息的唯一事实来源。
5. persistence ports (MessageStore + EventLog + InterruptStore) 持有 session 的运行时恢复状态与执行事实流（按 spanId）--但对话消息的 canonical 在 ledger，不在 persistence ports。

## 关联页面

- [事实与投影](./foundations/facts-and-projections.md)
- [Agent](./runtime/plugin.md)
- [会话消息流](./backend/conversation-projection.md)
- [Web 消息端到端](./flows/e2e-web-message.md)
- [飞书消息端到端](./flows/e2e-lark-message.md)
- [Web 端](./surfaces/web.md)
- [飞书适配器](./surfaces/lark-adapter.md)
