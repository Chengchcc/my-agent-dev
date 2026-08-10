---
id: harness.agent
title: Agent 编排层（已废止）
status: deprecated
owners: architecture
last_verified_against_code: 2026-08-05
summary: "本页描述旧 Agent 编排类（Agent/harness，createAgentSession、SessionManager、Checkpointer 拆分端口）。Phase 5/6 后不存在 backend 进程内的 Agent 编排对象；执行链为一次性 coding-agent 子进程内的 per-Run Runtime。本页保留为 tombstone。"
depends_on: []
used_by: []
---

# Agent 编排层（已废止）

> **这是一个 tombstone 页。** 旧 `harness`/`framework` 包已删除；`createAgentSession()`、`SessionManager`、`MessageStore/EventLog/InterruptStore` 等符号不再存在。

当前架构没有"backend 进程内长期活着的 Agent 对象"：

```text
Product Backend → Agent Run → Agent Backend → spawn 一次性 coding-agent 子进程
→ createCodingAgentRuntime()（per-Run Runtime）→ BackendRunOutcome → child 退出
```

CodingAgentSession（`packages/agent`）是当前真实 Runtime，但它按 Run 在子进程内创建，无跨 Run 生命周期。产品事实恢复只依赖 Conversation History 与 Agent Context。

相关当前页面：[Coding Agent](../runtime/coding-agent.md)、[系统总览](../system-overview.md)。
