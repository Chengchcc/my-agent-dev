---
id: backend.data-model
title: 目标数据模型
status: design
owners: architecture
summary: "目标数据模型以 Conversation History 和 Agent Context 为两类产品事实，并将 Agent Backend binding、Agent Run 和运行审计作为控制面数据。Runtime 私有 session 只以 opaque ID 绑定，不存为产品 transcript。"
depends_on:
  - foundations.facts-and-projections
  - agents.context
used_by:
  - backend.overview
  - runs.output-and-live-updates
---

# 目标数据模型

本页描述目标架构需要持久化的概念，不锁定具体 SQL 命名。实现迁移时可以复用现有表或增加新表，但字段语义必须符合本页不变量。

## 产品事实保存在哪里

### Conversation History

```text
conversation_ledger
  seq
  conversation_id
  sender_member_id
  addressed_to
  kind
  content
  run_id nullable
  created_at
```

Ledger 是多人共享 Conversation 历史。

### Agent Context

```text
agent_context_tree
  tree_id
  conversation_id
  agent_member_id
  created_at
  updated_at
```

```text
agent_context_entry
  entry_id
  tree_id
  parent_entry_id nullable
  type
  ledger_seq nullable
  payload
  created_at
```

Entry type：

```text
ledger_message
private_message
product_tool_exchange
summary
model_change
```

`model_change` payload 保存 `BackendModelRef`。Active branch 最后一个 `model_change` 决定下一个 Agent Run 的 effective model；不存在时使用 Product Agent 的 default model。共享 Message 使用 `ledger_seq` 引用 Ledger，不复制内容。

### Context Branch

```text
agent_context_branch
  branch_id
  tree_id
  leaf_entry_id nullable
  ledger_cursor
  backend_kind
  revision
  created_at
  updated_at
```

Branch 固定 `backend_kind`。Fork 新 branch 时默认继承，也可以显式选择另一个 backend。
## Execution session 绑定保存什么

```text
backend_session_binding
  branch_id PK
  backend_kind
  backend_session_id nullable
  synced_through_entry_id nullable
  product_revision
  status
  updated_at
```

`backend_session_id` 是 Claude/Codex/OpenCode/Coding Agent 的 opaque ID。Binding 可删除和重建，不属于 canonical history。
## Agent Run 如何持久化

```text
agent_run
  run_id
  branch_id
  status running|waiting|commit_failed|completed|failed|aborted|timeout
  pending_action_id nullable
  terminal_result nullable
  idempotency_key
  started_at
  ended_at nullable
  error nullable
  backend_kind
  model_ref
  system_prompt_hash nullable
  tool_manifest_hash nullable
  config_revision
```

同一 branch 只允许一个 active run。`running`、`waiting` 和 `commit_failed` 都属于 active：waiting 仍等待用户响应，commit_failed 仍等待 canonical commit 重放。数据库可使用 partial unique constraint 或 service-level CAS 保证：

```text
UNIQUE active run per branch
WHERE status IN (running, waiting, commit_failed)
```

Retry、provider request、run segment 和 sub-agent 是 Agent Backend 内部细节；如果 Product Backend 需要诊断，可以写审计表，但不改变 Agent Run 的单一终态。

## 输入队列如何持久化

Normal、steer 和 follow-up 都先写持久队列，再由 Agent Runs 投递：

```text
branch_input_queue
  id
  branch_id
  mode normal|steer|follow_up
  message
  status pending|delivering|delivered|cancelled
  created_at
  delivered_at nullable
```

Product Backend crash 后按同一 branch 内的创建顺序恢复 pending/delivering 项。Adapter 明确接收后才标记 delivered，因此需要 adapter/run idempotency key 防止重投产生重复语义。

## PendingAction 如何持久化

产品级审批或问题可建模为：

```text
pending_action
  action_id
  run_id
  branch_id
  kind
  payload
  status pending|resolved|cancelled
  response nullable
  created_at
  resolved_at nullable
```

Agent Backend 通过 MCP 或 Adapter fallback 请求产品能力；Product Backend 拥有审批事实。

## Product Summary 保存什么

Summary 是 `agent_context_entry(type=summary)`：

```ts
interface ProductSummaryPayload {
  summary: string;
  coversThroughEntryId: string;
  generator: string;
  usage?: Usage;
}
```

原始 entries 不删除。

## Product Tool exchange 保存什么

语义相关 Product Tool exchange 写入 Tree entry payload：

```ts
interface ProductToolExchangePayload {
  tool: string;
  callId: string;
  input: unknown;
  output: unknown;
  isError: boolean;
}
```

产品工具本身的业务事实仍写各自领域表，例如 Task 更新写 Task 表；Tree entry 保存的是 Agent context 所需语义记录。

## 运行审计保存什么

运行审计可以保留现有 span/attempt/control-plane/event 结构，也可以演进为统一 ops store。它保存：

```text
adapter/runtime raw diagnostics
model/tool timing
usage
process crash
capability/fallback decision
```

审计不参与 Agent Context context build，也不能替代 Terminal BackendRunOutcome。

## 哪些写入必须在同一事务

Agent terminal completed 时必须在同一事务完成：

```text
insert conversation_ledger
insert agent_context_entry ledger ref
update agent_context_branch leaf/revision
update backend_session_binding sync point
update agent_run terminal status
```

这个事务是 Agent Run 从执行结果变成产品事实的唯一 commit point。

## 不变量

1. Ledger 与 Tree 是两类产品事实。
2. execution session state 是可重建 cache metadata。
3. Agent Run 是 branch 上的一次产品执行，只有一个 terminal status。
4. 同一 branch 最多一个 active run。
5. 共享 Message 不在 Tree 中复制。
6. Summary 不删除原始 entries。
7. Agent Backend 私有 transcript 不进入产品数据模型。
8. 审计数据不作为语义恢复来源。

## 关联页面

- [系统总览](../system-overview.md)
- [Product Backend 总览](./overview.md)
- [Agent Context](../agents/context.md)
- [Agent Backend](../execution/agent-backend.md)
- [Conversation History](../conversation/history.md)
