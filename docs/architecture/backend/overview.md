---
id: backend.overview
title: Product Backend 总览
status: current
owners: backend-runtime
summary: "Product Backend 是产品事实与执行控制面的拥有者：Conversation History、Agent Context、Agent Run、输入队列、Workflow、Artifact 与 Product Tools MCP。每个 Run 由四后端之一（oma/claude/pi/omp）spawn 一次性子进程执行，terminal outcome 原子提交。"
depends_on:
  - architecture.system-overview
used_by:
  - backend.data-model
  - architecture.workflow
  - execution.agent-backend
  - agents.context
---

# Product Backend 总览

Product Backend 是系统的产品核心。它拥有 Conversation、共享消息、Agent Context 分支、Agent Run、Workflow、Artifact 和面向端的 HTTP/SSE API。执行只有一条链：**Agent Run → Agent Backend → 一次性子进程**；自动化由 Workflow 节点图驱动，agent 节点复用的仍是这条链。

## Product Backend 拥有什么

| 领域 | Product Backend 的职责 |
|---|---|
| Agent | 身份、角色、默认 Model、workspace、权限与产品配置（agent.yml 为真源） |
| Conversation | 触发规则、Conversation History、可见性（1:1 单 Agent，ADR 0021） |
| Agent Context | 每个 Agent 实际消费/产生的语义上下文、branch 与 summary |
| Agent Run | branch 级单 active run、终态提交、normal/steer/follow-up 队列 |
| Workflow | DSL 定义（*.workflow.json）、execution/node_run/pending_human、trigger 调度、SSE live/replay |
| Artifact | 带类型产物（fs 存储 + 元数据 + MCP 工具 + REST + 依赖校验） |
| Product Tools | History/todo 等产品能力经 MCP server 暴露；per-run token、幂等、审计 |
| Live Updates | Run 的实时文本、thinking、tool 和状态更新（可丢） |
| Workspace Bridge | 把 skill/mcp/product-tools 幂等桥接进工作区文件 |

Product Backend 不拥有子进程内部的模型循环、原生 tools、compaction、retry、插件加载或 todo —— 那些属于 Oma。

## 核心关系

```mermaid
flowchart LR
  Conversation --> History[(Conversation History)]
  Conversation --> Context[(Agent Context)]
  Workflow[Workflow] --> Run[Agent Run]
  Conversation --> Run
  Context --> Run
  Run --> Backend[Agent Backend]
  Tools[Product Tools MCP] --> Run
  Workflow --> Artifact[(Artifacts)]
  Backend --> Updates[Live Updates]
  Backend --> Message[Final Message]
  Message --> History
  Message --> Context
```

### Conversation History

共享会话事实。它保存人类与 Agent 的最终可见 Message、成员事件和产品控制条目。端从 History 重放，不依赖子进程的私有 transcript。

### Agent Context

一个 conversation 对应一份 Agent Context（1:1 后 tree 单键）。内部用 parent-linked entries 支持 branch/fork/rollback；公开语义是这个 Agent 实际消费和保留了什么。

### Agent Runs

Agent Run 是执行控制面的领域对象：固定 Context Branch、model/config snapshot（systemPrompt/skillRoots/permissionMode 冻结）、唯一终态。Product Backend 保证同一 Context Branch 最多一个 active Run，并持久化 normal、steer、follow-up 输入到 `branch_input_queue`。

### Agent Backend

Agent Run 通过 `backendKind`（oma / claude / pi / omp）选择执行引擎。Adapter spawn 一次性 child 进程执行；`runId` 是唯一执行身份。无 daemon、无 session、无 resume（CLI 后端靠自身原生 session 续接，ADR 0019）。

### Workflow 与 Artifact

Workflow 是编排层身份（execution/node_run/pending_human），不是执行身份；agent 节点创建普通 Agent Run，script 节点走进程沙箱，human 节点挂起于 Web 表单。Artifact 把「一次运行产出了什么」提为一等数据。详见 [Agentic Workflow](../workflow.md)。

### Product Tools

Product Tools 由 Product Backend 的 MCP server 统一执行并拥有权限、身份、幂等和审计（`product_tool_call` 表）。workspace bridge 写零密文 `.mcp.json`（env 名 + `${VAR}` 占位符），dispatch 时铸 per-run token、settle 时 revoke。MCP 是接入方式，不是 Product Tool 的领域身份。

## Message 如何进入 History 和 Context

### 人类消息

人类消息先写 Conversation History。只有 Agent 实际被触发时，Backend 才按 `ledgerCursor + visibility + context budget` 将该 Agent 真正消费的 Message refs 追加到 Agent Context。

获取 branch run ownership、同步 Ledger refs、推进 `ledgerCursor` 和创建 Agent Run 必须在同一事务中完成。若 branch 已有 active run，输入写入持久 `branch_input_queue`，不能先修改 Tree 再等待锁。

### Agent 输出

Live Updates 只用于实时展示。子进程返回 terminal `BackendRunOutcome` 后，Product Backend 在一个数据库事务中：

```text
写最终 assistant Message 到 Conversation History（agent_run_id 唯一提交标记）
→ 追加 Agent Context Message ref
→ 更新 Context Branch
→ 标记 Agent Run terminal
```

如果事务失败，Agent Run 进入 commit_failed，不能把 Run 标记为完成。

## Agent Run 并发与输入队列

Product Backend 不允许同一 branch 并行 Agent Run。新输入根据语义进入：

- normal：branch 空闲时开始；
- steer：希望尽快影响当前 Run（Adapter 立即转发给 live child；CLI 后端排队为下一 turn 输入）；
- follow-up：当前 Agent Run 结束后处理。

三类输入都先进入持久队列；Adapter 明确接受后才标记 delivered。Product Backend crash 后按 branch 内原顺序恢复（`listIdleBranchesWithPendingInputs` 在启动时恢复）。

## 失败原则

| 失败 | Product Backend 行为 |
|---|---|
| child 启动失败 / crash / malformed output | 该 Agent Run failed，保留 raw 诊断，不提交 final Message |
| preflight / projection / spawn / acceptance 失败 | 该 Agent Run failed，input cancelled，branch 释放（不重投、不产生 zombie） |
| terminal commit 事务失败 | Run 进入 commit_failed；幂等重试，成功前不释放 branch |
| Live Updates 推送失败 | 不影响事实；客户端从 Conversation History 恢复 |
| Product Tool 失败 | 返回标准化 tool result；按语义决定是否写 Agent Context |
| workflow 节点失败 | 逐节点记录；execution 以 failure 终态（agent 节点先 schema retry） |

## 不变量

1. Product Backend 是产品事实 owner。
2. Agent Backend 不拥有 Conversation History 或 Agent Context。
3. Agent Run 是唯一 Product execution identity（无 span/attempt/session）。
4. 同一 Context Branch 最多一个 active Agent Run。
5. Terminal outcome 决定 Agent Run 终态。
6. History Message 与 Context ref 必须原子提交。
7. 每个 Run 是 full Product Context projection，无跨 Run session/resume。
8. child 私有能力不能污染核心产品协议。
9. Workflow 是编排身份，不承载对话事实；Artifact 引用在节点边界校验存在性。

## 关联页面

- [系统总览](../system-overview.md)
- [Agentic Workflow](../workflow.md)
- [Agent Context](../agents/context.md)
- [Agent Backend](../execution/agent-backend.md)
- [Conversation History](../conversation/history.md)
- [事实与投影](../foundations/facts-and-projections.md)
- [数据模型](./data-model.md)
