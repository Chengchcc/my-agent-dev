---
id: plugins.task-guard
title: task-guard plugin（已废止）
status: deprecated
owners: architecture
last_verified_against_code: 2026-08-13
summary: "task-guard plugin 已删除。Coding Agent 的 stop 控制现在由 Coding Agent Runtime 自身的 force-continue 机制承担（packages/agent,stop 决策在 loop 内）。本页保留为 tombstone。"
depends_on: []
used_by: []
---

# task-guard plugin（已废止）

> **这是一个 tombstone 页。** task-guard 插件已从仓库删除（2026-08）。当前 Coding Agent 的插件为 `plugin-todo`、`plugin-progressive-skill`、`plugin-recap` 三个;stop 强制继续由 `packages/agent` 的 loop 内 `maxForceContinues` 机制承担。

相关当前页面:[Coding Agent](../runtime/coding-agent.md)。
