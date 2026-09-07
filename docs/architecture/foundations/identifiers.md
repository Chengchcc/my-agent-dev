---
id: foundations.identifiers
title: 标识符体系
status: current
owners: architecture
summary: "系统里的 id 分两类：实体主键（conversationId / agentId / memberId / treeId / branchId 等）与执行身份。执行身份只有一个：agentRunId，Agent Run 是唯一 Product execution identity，没有 span/attempt/session 概念。"
depends_on:
  - design-philosophy
  - foundations.facts-and-projections
used_by:
  - agent.oma
  - backend.overview
---

# 标识符体系

Phase 5/6 收敛后的标识符体系：实体主键彼此独立；执行身份收敛为**一个**：Agent Run 的 `runId`。历史文档中的 span/attempt/session 概念已全部删除（schema 迁移 0020 删除 `span`/`attempt`/`control_plane_event`/`span_origin` 表和 ledger 的 `span_id` 列）。

## 两类 id

### 实体主键（独立、不派生）

| id | 归属 |
|---|---|
| `conversationId` | Conversation |
| `memberId` | 成员（与 conversationId 复合） |
| `agentId` | Agent 身份 |
| `treeId` / `branchId` / `entryId` | Agent Context 树 / 分支 / 条目 |
| `cronJobId` / `projectId` / `loopId` | 各自领域实体 |

### 执行身份（只有一个）

```text
runId —— 一次 Agent Run（agent_run.run_id）
  ├── agentRunId（conversation_ledger.agent_run_id）← final assistant Message 的提交标记
  ├── idempotencyKey（run 级，唯一）
  └── inputId / callId（输入与 Product Tool 调用，run 内可派生）
```

- `runId` 由 Product Backend 在创建 Run 时生成（`crypto.randomUUID()`）。
- final assistant Message 的 `messageId = run:<runId>:assistant:<ordinal>`（`assistantMessageId(runId, ordinal)`，`packages/message/src/helpers.ts`）。
- terminal commit 写入 ledger 时带 `agent_run_id`（partial unique：一个 runId 的提交只能写一次）。
- `deliveryIdempotencyKey` / `inputIdempotencyKey` 保证队列重投与输入去重。

## 为什么没有 span/attempt/session

- 旧 `span`（一次 prompt loop 的审计实体）与 `attempt`（重试序号）依赖一个不存在的 backend 侧 supervisor 与 execution session；Phase 5 移除 supervisor 后它们失去 producer，Phase 6 删除表和全部读写路径。
- 旧 `sessionId` 是"持久记忆线"概念；当前 Runtime 的 SessionStore（`packages/agent`）是 **per-Run、in-memory** 的执行缓存：seed full Product history + input 后跑 loop，Run 结束即销毁，从不跨 Run 复用。
- 恢复语义：下一次输入 = 新 Run = 新的 full projection。没有 resume、没有 session 重建、没有 checkpointer。

## 每个 id 归属哪一层

```mermaid
flowchart TB
  subgraph product["Product Backend 层"]
    RUN["runId 生成<br/>agent_run / branch_input_queue / product_tool_call 生命周期"]
  end
  subgraph adapter["Adapter 层"]
    CHILD["runId 路由 execute/steer/abort<br/>deliveryIdempotencyKey 重投去重"]
  end
  subgraph runtime["Oma 层"]
    SESS["Runtime 内 sessionId = runId<br/>in-memory SessionStore，Run 结束销毁"]
  end
  RUN -->|execute(run snapshot)| CHILD
  CHILD -->|spawn + JSONL| SESS
```

一句话：**runId 属于 Product Backend（事实 owner），子进程内的 session 只是这次 Run 的执行缓存。**

## 关联页面

- [事实与投影](facts-and-projections.md)
- [Agent Backend](../execution/agent-backend.md)
- [数据模型](../backend/data-model.md)
- [设计哲学](../design-philosophy.md)
