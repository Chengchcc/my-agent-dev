---
id: foundations.lifecycle-overview
title: 一次运行的生命周期
status: current
owners: architecture
last_verified_against_code: 2026-07-28
summary: "一次 Agent 运行的完整时间线：从 Backend 创建 Agent，经 agent runtime (span-loop) 执行，到事件固化写账本，最后收尾释放。"
depends_on:
  - foundations.facts-and-projections
  - runs.output-and-live-updates
  - runtime.framework
  - harness.harness
used_by:
---

# 一次运行的生命周期

一次 Agent 运行从被触发到结束的生命周期。

## 时间线

```mermaid
sequenceDiagram
  participant B as Backend
  participant AG as Agent
  participant EL as EventLog
  participant L as Conversation History

  B->>AG: startAgentRun(input) -> 创建 Agent
  AG runs: span-loop
  AG emits AgentEvent
  AG-->>B: onEvent("message")
  B->>L: appendAssistantMessage -> 写入 MessageRevision
  AG runs: tool_call -> 执行 -> tool_result -> 继续
  AG emits AgentEvent（更多轮 -> 同 messageId）
  AG-->>B: onEvent("message")
  B->>L: 同 messageId 更新 revision
  AG->>EL: eventLog.appendEvent（非消息执行事件, 按 spanId）
  AG emits agent_end
  AG-->>B: onEvent("agent_end", willRetry: false)
  B->>L: terminal revision（state: done/error）
  B->>B: 释放 ConversationLock + fire-and-forget reflection
```

## 分阶段说明

**1. 发起**　Backend 收到触发信号（人发消息 / orchestrator 推进 Issue / cron 到点），创建 Agent，调用 `agent.prompt(input)`。

**2. 执行**　Agent 经 agent runtime (span-loop) 按步骤推进（受 maxSteps 约束）。每步可能调模型或调工具。过程拆成 AgentEvent 流。

**3. 固化事实**　Agent 的内部订阅者将事件通知给 Backend 注册的 listener，消息事件直接 `appendAssistantMessage` 写 conversation ledger。非消息执行事件（tool_call 等）不走这条回调，而由 agent runtime (span-loop) 经 `eventLog.appendEvent` 写入 EventLog 的执行事实流（`checkpoint_events`，按 spanId 切）。

**4. 收尾**　Run 结束时（`agent_end`），Backend 的 listener 写入 terminal revision 关闭消息，释放 ConversationLock。若被中断（InterruptSignal），Agent 保持存活，等待 `resume()` 调用后继续。

## 关联页面

- [事实与投影](facts-and-projections.md)
- [会话消息流](../runs/output-and-live-updates.md)
- [Agent](../runtime/plugin.md)
- [Framework 运行循环](../runtime/framework.md)
- [Web 消息端到端](../flows/e2e-web-message.md)
- [飞书消息端到端](../flows/e2e-lark-message.md)
