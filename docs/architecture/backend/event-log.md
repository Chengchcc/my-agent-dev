---
id: backend.event-log
title: EventLog（已废止）
status: deprecated
owners: backend-runtime
last_verified_against_code: 2026-08-05
summary: "EventLog / event_log 表是 runner daemon 时代的执行事实流容身处，早已失去写入方。Phase 6 删除整个执行审计体系（span/attempt/control_plane_event/span_origin）。本页保留为短 tombstone。"
depends_on: []
used_by: []
---

# EventLog（已废止）

> **这是一个 tombstone 页。** `event_log` 表、EventLog 概念与整个旧执行审计体系（`span`/`attempt`/`control_plane_event`/`span_origin`）已删除（迁移 0020），不提供数据转换工具。

当前执行链：

```text
Agent Run → oma child process → transient events / BackendRunOutcome
```

- 子进程事件（tool/llm 明细）是**瞬时投影**，不持久化为 Product 终态；`BackendRunOutcome` 是唯一终态权威。
- 持久执行事实只有：`agent_run`（终态 + terminal_result）、`product_tool_call`（Product Tool 幂等/审计）、`conversation_ledger` + `agent_context_*`（产品事实）。
- 没有 checkpointer、没有 checkpoint_events、没有按 sessionId/spanId 切的事件流。

相关当前页面：[事实与投影](../foundations/facts-and-projections.md)、[Agent Run 输出与实时更新](../runs/output-and-live-updates.md)。
