---
id: backend.conversation-projection
title: 会话消息流
status: current
owners: backend-runtime
last_verified_against_code: 2026-07-28
summary: "会话消息流描述 assistant 消息如何从 Agent 的 onEvent 回调写入 conversation ledger，并 fan-out 到 Web 和 Lark Bot。消息不经过独立进程--Agent 在 Backend 进程内产生事件，回调直接写 ledger。"
depends_on:
  - conversation.ledger
used_by:
  - surfaces.web
  - surfaces.lark-adapter
  - flows.e2e-web-message
  - flows.e2e-lark-message
  - operations.troubleshooting
---

# 会话消息流

会话消息流把 Agent 产生的 assistant 消息写入 conversation ledger，然后 fan-out 到各端。消息不经过 transport 或独立进程--Agent 在 Backend 进程内运行，通过 `onEvent` 回调直接写入。

核心概念：[conversation ledger](../conversation/ledger.md) 是对话的 canonical store；[Agent](../runtime/plugin.md) 管理 Agent 运行；执行事实流（tool_start/tool_end/llm_call）由 agent runtime (span-loop) 经 eventLog.appendEvent 写入 checkpoint_events（按 spanId 切），不进 ledger。

## startAgentRun：创建并监听 Agent

Backend 的 `startAgentRun` 创建 Agent 并注册内部回调：

```typescript
const agent = new Agent({ sessionId, plugins, messageStore, eventLog, interruptStore, ... });

agent.subscribe((event) => {
  if (event.type === "message") {
    // 直写 conversation ledger（critical）
    const seq = await convSvc.appendAssistantMessage({
      conversationId: cid, senderMemberId, runId,
      revision: event.payload,
    });
    // fan-out 到前端（best-effort, fire-and-forget）
    void convSvc.broadcastMessage(entry, { excludeMemberId: senderMemberId });
  }

  if (event.type === "agent_end" && !event.willRetry) {
    // terminal revision 写入
    await convSvc.appendAssistantMessage({ ...terminal revision });
    // 释放 ConversationLock
    lock.releaseOne(conversationId);
  }
});

await agent.prompt(input);
agent.dispose();
```

消息直接写入 ledger--不经过独立的 projection 步骤。非消息执行事件（tool_start、tool_end、llm_call 等）由 agent runtime (span-loop) 经 eventLog.appendEvent 写入 checkpoint_events（按 spanId 切），与对话消息分属两条流。

## 消息 revision upsert 模型

assistant 消息从 streaming → done/error 是同一个 `messageId` 的多次 revision。`appendAssistantMessage` 每次写入同一 `messageId` 的不同 state，前端按 `messageId` upsert。`runStatus` 字段（"retrying"/"compacting"）在 revision 上传递，前端从最新 revision 读取。

## `broadcastMessage` 的 fan-out

`broadcastMessage` 从 ledger 读取最新 entry，调用 `projectForMember` 为每个 agent member 构建视角投影，通过 SSE 推送到前端。SSE 直接从 ledger 读取 entry。

## 不变量

1. assistant 消息和人类消息经同一 `appendLedgerEntry` 底层入口写入 ledger。
2. ledger 是对话 canonical store；执行事实流（tool calls 等）在 EventLog 的 `checkpoint_events`，按 spanId 切，不进 ledger。
3. 消息从 Agent 的 `onEvent` 回调直接写入--不经过 transport。
4. reflect 使用独立的 `threadId`（`reflect:{original}`），消息不进主流 conversation ledger。
5. terminal 写入后释放 `ConversationLock`，不阻塞后续消息。

## 失败模式

- **写入失败**：`appendAssistantMessage` 是 critical path，失败上报，run 标记 error。
- **fan-out 失败**：不影响正确性——ledger 已持久化，客户端重连 SSE 后自动重放。

## 关联页面

- [Conversation Ledger](../conversation/ledger.md)
- [Agent](../runtime/plugin.md)
- [EventLog（已废止）](./event-log.md)
- [Web 消息端到端](../flows/e2e-web-message.md)
- [Lark 适配器](../surfaces/lark-adapter.md)
