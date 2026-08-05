---
id: runtime.coding-agent-prompt
title: Coding Agent Prompt 与 Context
status: current
owners: architecture
summary: "每个 Agent Run 使用 AgentRunSnapshot 冻结的 systemPrompt（Product Agent SOUL/identity/skill 契约）+ Meta User Message（runtime context）+ 真实 Prompt。三者在子进程内 seed 进 SessionStore，与 full Product history 一起构成模型输入。"
depends_on:
  - runtime.coding-agent
  - runtime.coding-agent-session
used_by:
---

# Coding Agent Prompt 与 Context

Prompt 分层在 Run 开始时由 Product Backend（systemPrompt 快照）与 Runtime（meta）确定。**systemPrompt/skillRoots 是 Agent Run 创建时冻结的 Run 级快照**（`agent_run.system_prompt` / `skill_roots`，输入队列行也携带自己的 request-time 快照）。

## 模型每次会收到什么

```text
full Product history（projected，source=product_history）
+ Meta User Message（source=meta）
+ Actual Prompt（source=prompt）
→ Agent Loop
```

Meta 与 Prompt 是两条连续 `user` Message。Provider conversion 层在某协议不接受连续同 role messages 时可以合并 wire payload，但不改写 SessionStore 里的条目。

## System Prompt 如何生成

Product Backend 在创建 Run 时渲染 `AgentRunSnapshot.systemPrompt`（Product Agent SOUL 与稳定身份、response style、behaviors、skill progressive-loading contract、critical rules），并冻结 `skillRoots`。SOUL 或稳定规则变化从**下一个 Agent Run** 生效 —— 不存在跨 Run 的 session 需要"热更新"。

## Meta User Message 放什么

Runtime 在 seed 时渲染：

```xml
<system-reminder>
# Runtime Context
# Memory
# Available Skills
# Product Context
# Workspace
...
</system-reminder>
```

Meta 包含动态内容：当前日期、workspace 与运行环境、Product Agent Memory 摘要/索引、Skill roots manifest 生成的 skill index、当前 Context Branch/Conversation context、Product Tool/MCP 使用说明、当前 model、todo reminder 与约束。Meta 不包含实际用户 Prompt、完整历史、全部 Skill 正文或大段 Memory facts。

## 哪些内容写入 SessionStore

```text
System Prompt   不写 SessionStore（来自 Run 快照）
Meta            写 SessionStore，source=meta
Actual Prompt   写 SessionStore，source=prompt
Full history    写 SessionStore，source=product_history（带 productEntryId）
```

每个 Run 恰好一条 Meta。相同 Run 的 provider retry 复用原 Meta，不重新渲染。Steer 不生成新 Meta；follow-up 是**新 Run**，重新读取最新快照并生成新 Meta。

## Skills 如何渐进加载

Runtime 扫描 Run 快照的 `skillRoots`（Skill Pack 物化出的绝对目录）找 `SKILL.md`，Meta 只注入可用 skill 名称、描述和加载规则。`skill_load` 按需加载正文（`packages/plugin-progressive-skill`）。

## Memory 由谁保存

Memory 由 Product Backend 拥有。Adapter/Product 将高价值摘要和索引渲染到 Meta；详细事实通过 Product Memory 工具渐进读取。Coding Agent 不自行成为 Product Memory canonical store。

## 不变量

1. System Prompt 结构稳定；每个 Run 渲染 Run 快照值且不写 SessionStore。
2. 每 Run 恰好一条 Meta User Message，在 Prompt 之前。
3. Retry 不重复生成 Meta；Steer 不生成 Meta；Follow-up 生成新 Meta（新 Run）。
4. Adapter/Product 构建 System/Meta；Runtime 不访问 Product DB。
5. Skill 正文渐进加载，不整包塞入 Meta。
6. Context shaping 无持久化副作用。

## 关联页面

- [Coding Agent](./coding-agent.md)
- [Coding Agent Session](./coding-agent-session.md)
- [Coding Agent Provider 与 ModelRuntime](./coding-agent-models.md)
- [Agent Backend](../execution/agent-backend.md)
