---
id: backend.data-model
title: 数据模型
status: current
owners: architecture
summary: "当前持久化模型：conversation_ledger 与 agent_context_tree/entry/branch 是两类产品事实，agent_run + branch_input_queue + product_tool_call 是执行控制面数据。无 span/attempt/control_plane_event/span_origin —— Agent Run 是唯一执行身份。"
depends_on:
  - foundations.facts-and-projections
  - agents.context
used_by:
  - backend.overview
  - runs.output-and-live-updates
---

# 数据模型
> ⚠ **部分过时(2026-08-13)**：span/attempt 等旧执行表已删（迁移 0020）；`agent_relationship` 表已删（迁移 0026）；members 模型按 ADR 0021 收编为单 Agent。schema 以 `apps/backend/src/infra/db/schema.ts` 为准。

本页描述当前 backend.db 的持久化模型（drizzle schema 是唯一真源，见 `apps/backend/src/infra/db/schema.ts`；字段名以 snake_case 为准）。

## 产品事实

### Conversation History

```text
conversation_ledger
  seq PK autoincrement
  conversation_id FK -> conversation
  sender_member_id
  addressed_to
  kind            message | member.joined | member.left | todo | surface.control | undo
  content         JSON（message 行为 serializeMessageRevision）
  ts
  agent_run_id    terminal-commit 身份：final assistant Message 的唯一提交标记（partial unique）
  undone
```

Ledger 是多人共享 Conversation 历史。`agent_run_id` 是唯一 Run 提交身份；**没有 span_id**。

### Agent Context

```text
agent_context_tree
  tree_id PK
  conversation_id FK
  agent_member_id
  created_at

agent_context_entry
  entry_id PK
  tree_id FK
  parent_id nullable（自引用）
  type            ledger_message | private_message | product_tool_exchange | summary | model_change
  payload         JSON
  ledger_seq nullable（仅 ledger_message）
  created_at

agent_context_branch
  branch_id PK
  tree_id FK
  leaf_entry_id nullable
  ledger_cursor
  backend_kind    "oma"
  is_default
  revision
  created_at
```

共享 Message 用 `ledger_seq` 引用 Ledger，不复制内容。`model_change` payload 保存 `BackendModelRef`；active branch 最后一个 `model_change` 决定下一个 Agent Run 的 effective model。

## 执行控制面

### Agent Run（唯一执行身份）

```text
agent_run
  run_id PK
  branch_id FK
  conversation_id
  agent_member_id
  model_ref       JSON: BackendModelRef
  status          running|waiting|commit_failed|completed|failed|aborted|timeout
  idempotency_key unique
  terminal_result JSON: serialized BackendRunOutcome（terminal 时写入）
  config_revision
  workspace_root / workspace_access     Run 级 workspace 快照
  product_tools   JSON: ProductToolDescriptor[]（首次 dispatch 时冻结）
  system_prompt / skill_roots           Run 级配置快照（创建时冻结）
  created_at / terminal_at
```

同一 branch 只允许一个 active run（partial unique index on `status IN ('running','waiting','commit_failed')`）。

### Branch Input Queue

```text
branch_input_queue
  seq PK autoincrement（单调队列顺序）
  input_id unique
  branch_id FK
  mode            normal | steer | follow_up
  message         JSON: serialized Message
  status          pending | delivering | delivered | cancelled
  delivery_idempotency_key unique
  input_idempotency_key
  run_id          acquired 时写入
  model_ref / config_revision / workspace_root / workspace_access
  system_prompt / skill_roots           request-time 配置快照（promote 时用输入自己的）
  created_at / delivered_at
```

Product Backend crash 后按同一 branch 内的 seq 顺序恢复 pending 项并重新 promote。

### Product Tool Calls

```text
product_tool_call
  run_id FK, call_id
  tool_name
  input_hash
  status      completed | failed
  result / error
  created_at / completed_at
  PK(run_id, call_id)
```

语义变更类 Product Tool（如 history_retain）的幂等与审计。replay 返回存储结果，冲突输入失败。

### 其余实体表

- `workflow_execution` / `workflow_node_run` / `workflow_execution_event` / `workflow_pending_human`：Workflow 编排层身份（definition 冻结、节点运行与路由、事件流、human 挂起）
- `agent_run_event`：Run 级事件持久化（可选 audit）
- `pending_action`：审批/问答等待响应（Product-side 记录，Run 协议本身只有四个终态）
- `skill_pack` / `agent_skill_pack`：Skill Pack 与 Agent 分配
- `knowledge_pack`：知识库安装记录
- `agents` / `conversation` / `project`：实体锚点（agent 配置以工作区 agent.yml 为真源，DB 只存缓存）
- `settings`、`surface_health`：KV 与 Lark 心跳等 audit

**不是表**：Artifact 走 fs 存储（`features/artifact`，无 SQLite 表）；MCP server 目录走文件（`features/mcp/adapter-file.ts`，非 DB 行）。

**已删除**：`span` / `attempt` / `control_plane_event` / `span_origin`（Phase 6，迁移 0020）；`loop_item` / `loop_budget`（Loop 删除，迁移 0043）；`cron_job`（CronJob 删除，迁移 0042）；`agent_relationship`（迁移 0026）。

## 哪些写入必须在同一事务

Agent terminal completed 时必须在同一事务完成：

```text
insert conversation_ledger（final assistant Message，agent_run_id）
insert agent_context_entry ledger ref
update agent_context_branch leaf/revision
update agent_run terminal status + terminal_result
```

这个事务是 Agent Run 从执行结果变成产品事实的唯一 commit point。

## 不变量

1. Ledger 与 Tree 是两类产品事实。
2. Agent Run 是 branch 上的一次产品执行，只有一个 terminal status。
3. 同一 branch 最多一个 active run。
4. 共享 Message 不在 Tree 中复制。
5. Summary 不删除原始 entries。
6. child 私有 transcript 不进入产品数据模型。
7. 无 span/attempt/session 概念；`runId` 是唯一执行身份。

## 关联页面

- [系统总览](../system-overview.md)
- [Product Backend 总览](./overview.md)
- [Agent Context](../agents/context.md)
- [Agent Backend](../execution/agent-backend.md)
- [Conversation History](../conversation/history.md)
