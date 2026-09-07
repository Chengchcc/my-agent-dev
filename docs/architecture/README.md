---
id: architecture.index
title: 架构 Wiki 首页
status: current
owners: architecture
summary: "当前架构：Product Backend 保存 Conversation History 与 Agent Context，创建 Agent Run；四 Agent Backend(oma/claude/pi/omp)为每个 Run spawn 一次性子进程；Agent 配置与记忆住在工作区文件里(Workspace Bridge 桥接)；对话是单 Agent 的 session 产品态投影(ADR 0021)。"
depends_on:
used_by:
---

# 架构文档

这套文档描述**当前架构**：Product Backend 保存 Conversation History 和 Agent Context，创建 Agent Run；Agent Backend(四个 adapter)为每个 Run spawn 一次性子进程；Agent 的配置、技能、MCP、记忆都住在工作区文件里，由 Workspace Bridge 桥接；一个对话 = 一个 Agent 的 session 产品态投影。

```text
Product Backend
→ durable Agent Run
→ Agent Backend(按 kind:oma / claude / pi / omp)
→ spawn one-shot child
→ (自研)stdin/stdout JSONL RPC / (CLI)argv+stdin
→ native session 续接(cliSessionRef 透传)
→ BackendRunOutcome
→ atomic Product terminal commit
```

1. [系统总览](./system-overview.md)：产品事实、Agent Run 与执行链的全景。
2. [Agent 工作区与多后端](./agents/workspace-and-backends.md)：文件即配置、四后端、session 投影(现行模型入口)。
3. [Agentic Workflow](./workflow.md)：声明式节点图、Artifact、trigger 调度。
4. [Conversation History](./conversation/history.md)：Conversation 共同发生了什么。
5. [Agent Context](./agents/context.md)：每个 Agent 实际知道什么，以及如何 branch。
6. [Agent Backend](./execution/agent-backend.md)：Agent Run 如何交给子进程。

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

1. [Agent 工作区与多后端](./agents/workspace-and-backends.md)
2. [Agent Backend](./execution/agent-backend.md)
3. [Oma Runtime](./runtime/oma.md)
4. [Oma 插件与 HITL](./plugins/oma-plugins.md)

### Workflow / Artifact

声明式节点图编排(agent/script/human 节点 + JSON-Logic 边 + cron 触发)与带类型产物：

1. [Agentic Workflow](./workflow.md)
2. [Project 与 Worktree](./agents/projects-and-worktrees.md)
3. [数据模型](./backend/data-model.md)

### 规则、参考与运维

1. [跨进程契约规则](./e2e-contract-rules.md)
2. [DB 类型链规则](./db-typesafe-rules.md)
3. [生命周期总览](./foundations/lifecycle-overview.md)
4. [Provider 架构](./provider-architecture-spec.md)
5. [Compaction](./runtime/compaction.md)
6. [Skill Pack](./plugins/skill-pack.md)
7. [安全模型](./security/overview.md) / [oma 内核安全面](./security/oma-kernel.md) / [安全债清单](./security-debt-backlog.md)

## 核心概念

| Agent | 身份、角色、Memory、Skills、默认 Model 与 workspace(全部为工作区文件) |
| Conversation | 单一 Agent 的 session 产品态投影(ADR 0021) |
| Message | 人类或 Agent 产生的唯一消息领域对象 |
| Conversation History | Conversation 中共同发生的事实 |
| Agent Context | Agent 实际消费和保留的语义历史 |
| Context Branch | Agent Context 中一条可 fork/rollback 的历史路径 |
| Agent Run | Context Branch 上的一次持久产品执行(唯一执行身份) |
| Agent Backend | 执行 Agent Run 的引擎边界(四个实现：oma / claude / pi / omp) |
| Workflow | 声明式节点图编排：agent/script/human + cron 触发；execution 是编排层身份 |
| Artifact | 带类型产物(artifacts:// 引用)，节点间与聊天中可传递 |
| Workspace Bridge | 把 skill/mcp/product-tools 幂等桥接进工作区文件的后端机制 |
| Product Tool | Conversation History、todo 等产品能力(MCP server + per-run token) |
| Oma | 本仓库自研 CLI 执行引擎：print/json/rpc 一次性模式(Adapter spawn rpc) + TUI 交互终端 |

## 设计约束

```text
Conversation 保存共享 Message(单 Agent 线)。
Agent Context 保存 Agent 实际知道什么。
Agent Run 记录一次产品执行。
Agent Backend 为每个 Run spawn 一次性子进程，按 kind 选实现。
```

- 无跨 Run session/resume/daemon：上下文续接 = 各后端原生 session + 首轮 flat-text 桥。
- Streaming 不进入 Conversation History 或 Agent Context。
- Agent 最终 Message 与 Context 引用必须同事务提交(agent_run_id 唯一标记)。
- Product Tools 的权限和事实归 Product Backend。
- Oma 的 loop、retry、compaction、todo 和 skill 加载都是子进程内部实现。

## 结构化入口

- [LLM 索引](./index.llm.md)
- [概念图谱](./concepts.json)
- [跨页地图](./map.md)

## 文档写法

1. 主 Wiki 只描述当前架构；历史迁移、旧包名和临时兼容路径放 ADR/plan，不放主叙述。
2. 每篇页面必须独立定义必要上下文。
3. 已删除的概念(span/attempt/session/daemon/checkpointer/Pet/Recap/relationships/多成员/Loop/CronJob)**不保留文档页**：直接删除文档，历史见 `docs/adr/` 与 git 记录。
