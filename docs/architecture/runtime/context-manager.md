---
id: runtime.context-manager
title: 上下文管理器（已废止）
status: deprecated
owners: architecture
last_verified_against_code: 2026-08-05
summary: "本页描述旧 Product Runtime 的 ContextPipeline（消息裁剪/摘要/预算，pipeContextManagers）。Phase 5/6 后该机制移入 Oma Runtime（packages/agent，compaction 为 Run-local 缓存），Product Backend 不再拥有上下文整形。本页保留为 tombstone。"
depends_on: []
used_by: []
---

# 上下文管理器（已废止）

> **这是一个 tombstone 页。** Product Backend 不再拥有上下文整形管线。上下文预算与压缩（compaction）是 Oma Runtime 的内部机制（`packages/agent`），属于可丢弃的执行缓存：只影响本次 Run 的模型输入，不写产品历史，Run 结束即销毁。

产品侧对应的概念是 Product Summary（Agent Context 的 `summary` entry），由 Product Policy 决定，只改变投影，不删除原始历史。见 [事实与投影](../foundations/facts-and-projections.md)。

相关当前页面：[Oma](./oma.md)、[Oma Session](./oma-session.md)。
