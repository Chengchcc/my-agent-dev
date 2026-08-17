---
id: runtime.framework
title: Framework 运行循环（已废止）
status: deprecated
owners: architecture
last_verified_against_code: 2026-08-05
summary: "本页描述旧 Product Runtime 的 in-process 运行循环（AgentHooks/checkpointer/persistence ports）。Phase 5/6 后执行链是 Product Backend → Agent Backend → 一次性 oma 子进程；运行循环位于 packages/agent（Oma Runtime），以 Run 为单位在子进程内执行。本页保留为 tombstone。"
depends_on: []
used_by: []
---

# Framework 运行循环（已废止）

> **这是一个 tombstone 页。** 旧 `framework` 包已删除；`AgentHooks`、`Checkpointer`、`MessageStore/EventLog/InterruptStore` persistence ports 与 backend 进程内运行循环已不存在。

当前执行链：

```text
Product Backend → Agent Run → Agent Backend → spawn 一次性 oma 子进程
→ per-Run Oma Runtime（packages/agent）→ BackendRunOutcome → terminal commit
```

运行循环（model/tool loop、retry、compaction、todo、skill 加载）位于 `packages/agent/src/runtime/agent-loop.ts`，每次 Run 在子进程内新建，Run 结束即销毁。没有跨 Run session、没有 checkpointer、没有进程内 supervisor。

相关当前页面：[Oma](./oma.md)、[Agent Backend](../execution/agent-backend.md)。
