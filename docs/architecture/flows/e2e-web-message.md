---
id: flows.e2e-web-message
title: Web 消息端到端
status: current
owners: architecture
last_verified_against_code: 2026-07-28
summary: "Web 消息的完整生命周期：用户发送消息 -> 账本记录 -> Agent 执行 -> onEvent 回调写入 MessageRevision -> 账本 SSE 推送到前端。Agent 在 Backend 进程内直接执行。"
depends_on:
  - surfaces.web
  - backend.conversation-projection
used_by:
---

# Web 消息端到端

Web 用户在对话中发消息后，经过以下几个阶段完成往返：消息写入 conversation ledger，Agent 在 Backend 进程内执行，assistant 消息通过账本 SSE 推送到前端，前端按 messageId upsert 渲染。

## 时序图

```mermaid
sequenceDiagram
  participant U as 用户
  participant W as Web
  participant B as Backend
  participant AG as Agent
  participant EL as EventLog
  participant L as Conversation Ledger

  U->>W: 发消息 / @agent
  W->>W: 加乐观消息（opt-）
  W->>B: POST /api/conversations/:id/messages
  B->>L: 写入人类 MessageRevision
  L-->>W: 账本 SSE 回声 -> upsert 乐观消息（按 messageId）
  AG: createAgentSession + prompt
  AG->>AG: span-loop（自动多轮）
  AG-->>B: onAssistantMessage("message_update") -> appendAssistantMessage
  B->>L: appendAssistantMessage -> 写入 MessageRevision（同 messageId）
  L-->>W: 账本 SSE（push buffer + 100ms poll）-> upsert -> UI 显示 streaming
  AG-->>AG: tool_call -> execute -> tool_result -> 继续产出
  AG emits agent_end
  AG-->>B: onEvent("agent_end", willRetry: false)
  B->>L: terminal revision（state: done）
  L-->>W: 账本 SSE -> 同 messageId upsert -> UI 显示终态
```

## BFF 路由

Web 端 API 调用直接挂载在 `/api` 前缀下（无 `/bff` 中间层）。conversation SSE 走 `/api/conversations/:id/events`，消息 POST 走 `/api/conversations/:id/messages`。

前端维护一份按 `messageId` 索引的消息列表。assistant 消息从 streaming 到 done 是同一 `messageId` 的多次 revision，每次账本 SSE 到达时按 `messageId` upsert。

`MessageRevision` 携带 `runStatus` 字段，可取值："running"（正常执行中）、"retrying"（自动重试中）、"compacting"（压缩上下文中）、"waiting"（等待审批）。前端从当前 revision 的 `runStatus` 推导状态指示器。

前端不维护独立的 run 阶段状态——消息的 `state`（streaming/done/error/waiting）和 `runStatus` 字段本身就是状态来源。

## 关联页面

- [Web 端](../surfaces/web.md)
- [Agent](../runtime/plugin.md)
- [会话消息流](../backend/conversation-projection.md)
- [Framework 运行循环](../runtime/framework.md)
