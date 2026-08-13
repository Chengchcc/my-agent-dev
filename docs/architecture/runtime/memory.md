---
id: runtime.memory
title: Memory（已废止,工作区文件取代）
status: deprecated
owners: architecture
last_verified_against_code: 2026-08-13
summary: "原 plugin-memory 设计从未落地(packages/plugin-memory 不存在)。记忆现为 Agent 工作区文件:memory/MEMORY.md + memory/facts/*.md,agent 自行读写,backend 展示(见 agents/workspace-and-backends.md)。本页保留为 tombstone。"
depends_on: []
used_by: []
---

# Memory（已废止,工作区文件取代）

> **这是一个 tombstone 页。** 本页曾描述 `plugin-memory` 的三工具 + 两阶段自动提取 pipeline——该插件从未实现。

现状(ADR 0020/0021):

- 记忆 = 工作区文件:`memory/MEMORY.md`(汇总)+ `memory/facts/*.md`(agent 自写事实);
- agent 在运行中自己读写这些文件(workspace 即状态);
- backend 负责目录保障与展示:`features/agent/agent-identity.ts`、`GET /api/agents/:id/memory`。

相关当前页面:[Agent 工作区与多后端](../agents/workspace-and-backends.md)。
