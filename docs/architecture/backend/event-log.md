---
id: backend.event-log
title: EventLog（已废止）
status: deprecated
owners: backend-runtime
last_verified_against_code: 2026-06-27
summary: "EventLog（event_log 表）是 runner daemon 时代从 checkpointer 剥离出去的「执行事实流」临时容身处。daemon 删除后它失去写入方、成为死表。执行事实流职责已归还 checkpointer（见 checkpoint_events，按 spanId 切）。本页保留为 tombstone，新设计不要再引用 EventLog。"
depends_on:
  - foundations.identifiers
  - foundations.facts-and-projections
used_by:
---

# EventLog（已废止）

> **这是一个 tombstone 页。** `event_log` 表与 EventLog 概念已废止，新设计不要再引用。执行事实流（tool_start/tool_end/llm_call 等非消息事件）的职责已归还 [checkpointer](../foundations/identifiers.md#执行事实流回归-checkpointer)。

## 为什么会有 EventLog，又为什么废止

执行事实流（一次运行内的模型/工具调用明细）本就是 **checkpointer** 该持有的东西——它是 session 运行档案的一部分。runner daemon 时代，runner 在独立进程里执行 Agent，需要把这些事件跨进程上报给 backend，于是把这份职责从 checkpointer 剥离出来，落进 backend 自己的一张独立表 `event_log`，按 `runId` 切。

runner daemon 删除后，Agent 改为在 backend 进程内直接执行。跨进程上报的前提消失，`event_log` 表也随之**失去了任何生产写入方**（仅测试代码仍写），成为死表。`supervisor` 上注册的 `onRunEvent` 钩子从不触发，是这段剥离留下的残骸。

## 现在去哪了

执行事实流回归 checkpointer：

| 旧（EventLog） | 新（checkpointer） |
|---|---|
| `event_log` 表，独立于 checkpointer.db | `checkpoint_events`，与 messages/interrupts 同库同源 |
| 按 `runId` 切 | 按 `sessionId` + `spanId` 切（见[标识符体系](../foundations/identifiers.md)） |
| `eventLog.append` / `eventLog.read`（runner 上报） | `checkpointer.appendEvent` / `readEvents`（run-loop 内写，去 `@deprecated`） |
| 由 backend supervisor 写 | 由 framework run-loop 写（spanId 经 runtime context 透传） |

写入路径与 spanId 透传细节见[标识符体系](../foundations/identifiers.md#决定agentsession-跨-span-持久)。可观测/排障读取一律走 `checkpointer.readEvents`，不再有独立的 EventLog 读端。

## 关联页面

- [标识符体系](../foundations/identifiers.md) —— 执行事实流回归 checkpointer、按 spanId 切
- [事实与投影](../foundations/facts-and-projections.md) —— checkpointer 同时持有恢复状态与执行事实流
- [会话消息流](./conversation-projection.md)
