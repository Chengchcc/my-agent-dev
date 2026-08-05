---
id: architecture.index
title: 架构 Wiki 首页
status: current
owners: architecture
summary: "当前架构：Product Backend 保存 Conversation History 与 Agent Context，创建 Agent Run；Agent Backend 为每个 Run spawn 一次性 coding-agent 子进程（stdin/stdout JSONL RPC）；BackendRunOutcome 是唯一终态，terminal commit 原子写入。"
depends_on:
used_by:
---

# 架构文档

这套文档描述**当前架构**：Product Backend 保存 Conversation History 和 Agent Context，创建 Agent Run；Agent Backend（`packages/adapter-coding-agent`）为每个 Run spawn 一个一次性 `coding-agent --mode rpc` 子进程；子进程内的 per-Run Runtime 产出 `BackendRunOutcome`，Product Backend 据此原子提交最终 Message 与 Context。

```text
Product Backend
→ durable Agent Run
→ full Product Context projection
→ Agent Backend
→ spawn one-shot coding-agent child
→ stdin/stdout JSONL RPC
→ per-Run Coding Agent Runtime
→ BackendRunOutcome
→ atomic Product terminal commit
```

## 推荐阅读顺序

1. [系统总览](./system-overview.md)：产品事实、Agent Run 与执行链的全景。
2. [Conversation History](./conversation/history.md)：Conversation 共同发生了什么。
3. [Agent Context](./agents/context.md)：每个 Agent 实际知道什么，以及如何 branch。
4. [Agent Backend](./execution/agent-backend.md)：Agent Run 如何交给 coding-agent 子进程。

## 按主题查找

### Product Backend 与数据归属

1. [Product Backend 总览](./backend/overview.md)
2. [数据模型](./backend/data-model.md)
3. [Conversation History](./conversation/history.md)
4. [Agent Context](./agents/context.md)
5. [Agent Run 输出与实时更新](./runs/output-and-live-updates.md)

### Web / Lark 消息链路

1. [Web 消息端到端](./flows/e2e-web-message.md)
2. [Web 端](./surfaces/web.md)
3. [飞书](./surfaces/lark.md)
4. [Conversation History](./conversation/history.md)

### 执行链

1. [Agent Backend](./execution/agent-backend.md)
2. [Coding Agent](./runtime/coding-agent.md)
3. [Coding Agent Session](./runtime/coding-agent-session.md)
4. [Coding Agent Prompt 与 Context](./runtime/coding-agent-prompt.md)
5. [Coding Agent Provider 与 ModelRuntime](./runtime/coding-agent-models.md)

### Task / Cron / Loop

这些产品能力创建 Agent Run，不直接依赖子进程内部实现：

1. [CronJob](./foundations/cron-job.md)
2. [Loop](./foundations/loop.md)

## 核心概念

| 术语 | 含义 |
|---|---|
| Agent | 身份、角色、Memory、Skills、默认 Model 与 workspace |
| Conversation | 多成员共享协作空间 |
| Message | 人类或 Agent 产生的唯一消息领域对象 |
| Conversation History | Conversation 中所有成员共同发生的事实 |
| Agent Context | 单个 Agent Member 实际消费和保留的语义历史 |
| Context Branch | Agent Context 中一条可 fork/rollback 的历史路径 |
| Agent Run | Context Branch 上的一次持久产品执行（唯一执行身份） |
| Agent Backend | 执行 Agent Run 的引擎边界（当前唯一实现：CodingAgentBackend） |
| Product Tool | Conversation History、审批等产品能力 |
| Coding Agent | 本仓库自研、无 UI 的一次性 CLI 执行引擎 |

## 设计约束

```text
Conversation 保存共享 Message。
Agent Context 保存某个 Agent 实际知道什么。
Agent Run 记录一次产品执行。
Agent Backend 为每个 Run spawn 一次性 coding-agent 子进程。
```

- 每个 Run 是 full Product Context projection；无跨 Run session/resume/daemon。
- Streaming 不进入 Conversation History 或 Agent Context。
- Agent 最终 Message 与 Context 引用必须同事务提交（agent_run_id 唯一标记）。
- Product Tools 的权限和事实归 Product Backend。
- Coding Agent 的 loop、retry、compaction、todo 和 skill 加载都是子进程内部实现。

## 结构化入口

- [LLM 索引](./index.llm.md)
- [概念图谱](./concepts.json)
- [跨页地图](./map.md)

## 文档写法

1. 主 Wiki 只描述当前架构；历史迁移、旧包名和临时兼容路径放 ADR/plan，不放主叙述。
2. 每篇页面必须独立定义必要上下文。
3. 已删除的概念（span/attempt/session/daemon/checkpointer/Pet/Recap）只以 tombstone 或历史 ADR 形式出现。
