---
id: architecture.index
title: 架构 Wiki 首页
status: design
owners: architecture
summary: "目标架构以 Agent、Conversation、Message、Conversation History、Agent Context、Context Branch、Agent Run、Agent Backend、Product Tool 和 Coding Agent 为核心概念。"
depends_on:
used_by:
---

# 架构文档

这套文档描述目标架构：Product Backend 保存 Conversation History 和 Agent Context，创建 Agent Run；Claude Code、Codex、OpenCode 和 Coding Agent 作为 Agent Backend 执行 Run。

建议先阅读系统总览、Conversation History、Agent Context、Agent Run 和 Agent Backend。页面中的 `status: design` 表示设计已固定，但代码尚未全部迁移。

## 推荐阅读顺序

1. [系统总览](./system-overview.md)：产品事实、Agent Run 和执行引擎的全景。
2. [Conversation History](./conversation/history.md)：Conversation 共同发生了什么。
3. [Agent Context](./agents/context.md)：每个 Agent 实际知道什么，以及如何 branch。
4. [Agent Backend](./execution/agent-backend.md)：Agent Run 如何交给不同执行引擎。

## 按主题查找

### Product Backend 与数据归属

1. [Product Backend 总览](./backend/overview.md)
2. [目标数据模型](./backend/data-model.md)
3. [Conversation History](./conversation/history.md)
4. [Agent Context](./agents/context.md)
5. [Agent Run 输出与实时更新](./runs/output-and-live-updates.md)

### Web / Lark 消息链路

1. [Web 消息端到端](./flows/e2e-web-message.md)
2. [Web 端](./surfaces/web.md)
3. [飞书](./surfaces/lark.md)
4. [Conversation History](./conversation/history.md)

### 可替换 Agent 执行引擎

1. [Agent Backend](./execution/agent-backend.md)
2. [Agent Context](./agents/context.md)
3. [Product Backend 总览](./backend/overview.md)

Coding Session、Plugin、Prompt、Model/Provider 和 Worker 生命周期属于 Coding Agent 内部设计，不进入 Product Backend 主心智。

### 在 Coding Agent 上工作

1. [Coding Agent](./runtime/coding-agent.md)
2. [Coding Agent Session](./runtime/coding-agent-session.md)
3. [Coding Agent Prompt 与 Context](./runtime/coding-agent-prompt.md)
4. [Coding Agent Provider 与 ModelRuntime](./runtime/coding-agent-models.md)

### Task / Cron / Loop

这些产品能力创建 Agent Run，不直接依赖某个执行引擎的内部 session 或 loop：

1. [CronJob](./foundations/cron-job.md)
2. [Loop](./foundations/loop.md)

## 核心概念

| 术语 | 含义 |
|---|---|
| Agent | 身份、角色、Memory、Skills、默认 Agent Backend 和 Model |
| Conversation | 多成员共享协作空间 |
| Message | 人类或 Agent 产生的唯一消息领域对象 |
| Conversation History | Conversation 中所有成员共同发生的事实 |
| Agent Context | 单个 Agent Member 实际消费和保留的语义历史 |
| Context Branch | Agent Context 中一条可 fork/rollback 的历史路径 |
| Agent Run | Context Branch 上的一次持久产品执行 |
| Agent Backend | 执行 Agent Run 的可替换引擎 |
| Product Tool | Conversation、Task、Memory、Artifact、History 等产品能力 |
| Coding Agent | 本项目自研、无 UI 的 coding execution engine |

## 设计约束

```text
Conversation 保存共享 Message。
Agent Context 保存某个 Agent 实际知道什么。
Agent Run 记录一次产品执行。
Agent Backend 执行 Agent Run。
```

- Context Branch 内固定 Agent Backend；切换 Backend 必须 fork。
- Streaming 不进入 Conversation History 或 Agent Context。
- Agent 最终 Message 与 Context 引用必须同事务提交。
- Product Tools 的权限和事实归 Product Backend。
- Coding Agent 的 session、worker、provider 和 compaction 都是内部实现。

## 结构化入口

- [LLM 索引](./index.llm.md)
- [概念图谱](./concepts.json)
- [跨页地图](./map.md)

## 文档写法

1. 主 Wiki 描述目标架构，不把当前临时实现当成长期边界。
2. 每篇页面必须独立定义必要上下文。
3. 历史迁移、旧包名和临时兼容路径放 ADR/plan，不放主叙述。
4. 未固定的自研 Runtime 细节暂不写成目标事实。
