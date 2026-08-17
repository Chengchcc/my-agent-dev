---
id: plugins.memory
title: 记忆插件（已废止）
status: deprecated
owners: architecture
last_verified_against_code: 2026-08-13
summary: "plugin-memory / plugin-fs-memory 均不存在。记忆已吸收进 Agent 工作区文件模型（ADR 0020/0021）:workspace 的 memory/MEMORY.md + memory/facts/*.md 由 agent 自行读写,backend 只做展示(agent-identity + /api/agents/:id/memory)。本页保留为 tombstone。"
depends_on: []
used_by: []
---

# 记忆插件（已废止）

> **这是一个 tombstone 页。** 记忆不再是插件,而是工作区文件(ADR 0020:Agent 工作区即配置)。现状:

- `memory/MEMORY.md` — 汇总/dated memory;`memory/facts/*.md` — agent 自写事实;
- backend `features/agent/agent-identity.ts` 确保目录存在并读取展示;`GET /api/agents/:id/memory` 供 Web 的 Memory tab;
- SOUL.md / USER.md 经 cwd meta 注入 Oma(system prompt 通道)。

相关当前页面:[Agent 工作区与多后端](../agents/workspace-and-backends.md)。
