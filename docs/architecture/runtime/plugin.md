---
id: runtime.plugin
title: 运行时插件机制（已废止）
status: deprecated
owners: architecture
last_verified_against_code: 2026-08-05
summary: "本页描述旧 Product Runtime 的插件机制（createAgentSession/PluginHooks/AgentHooks）。Phase 5/6 后插件仅存在于 Oma Runtime（packages/agent）：当前真实插件为 plugin-todo 与 plugin-progressive-skill，随子进程按 Run 加载。本页保留为 tombstone。"
depends_on: []
used_by: []
---

# 运行时插件机制（已废止）

> **这是一个 tombstone 页。** 旧的 Product Runtime 插件栈（`createAgentSession`、`AgentHooks`、`createHookPlugin` 等）已随 daemon/session 架构删除。Product Backend 不再加载任何 runtime plugin。

当前真实插件（Oma 能力，随子进程按 Run 加载）：

- `packages/plugin-todo` —— Run-local todo 跟踪；
- `packages/plugin-progressive-skill` —— Skill Pack 渐进加载。

插件机制位于 `packages/agent`（PluginHooks，beforeRun/beforeModel/afterModel/beforeTool/afterTool/beforeStop），是 Oma 内部实现，不进入 Product Backend 主心智。

相关当前页面：[Oma](./oma.md)、[渐进式技能](../plugins/progressive-skill.md)。
