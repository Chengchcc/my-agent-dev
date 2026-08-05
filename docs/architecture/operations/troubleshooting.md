---
id: operations.troubleshooting
title: 排障指南
status: current
owners: backend-runtime
summary: "按事实层与执行层定位问题：Ledger/Tree 是产品事实，Agent Run + branch_input_queue + product_tool_call 是执行控制面，子进程与 Live Updates 是缓存/投影。Agent Run 是唯一执行身份，无 span/attempt/session。"
depends_on:
  - foundations.facts-and-projections
used_by:
  - backend.overview
---

# 排障指南

## 先分层，再定位

遇到问题，先问一句：这是**事实**坏了，还是**执行/投影**坏了？

- 事实层：`conversation_ledger`（对话历史）、`agent_context_*`（Agent Context）—— durable product facts；
- 执行层：`agent_run`、`branch_input_queue`、`product_tool_call`、`pending_action`；
- 缓存/投影：一次性 coding-agent 子进程（transcript/stderr）、Live Updates/SSE。

事实错了影响所有端；执行层问题影响某个 Run 的终态；投影问题只影响某个端的视图。

## 症状对照

| 症状 | 先看哪里 | 根因方向 |
|---|---|---|
| 某成员看不到本该有的消息 | `conversation_ledger` 该 conversation 的 entries | 消息没写入账本；SSE fan-out 失败；前端投影没跟上 |
| 所有人都缺同一条消息 | 账本 + agent_run terminal_result | terminal commit 事务失败（Run 停在 commit_failed）；child 没产出 final Message |
| Run 卡在 running 不动 | agent_run.status + child 进程 | execute 未被接受（queue 停在 delivering）；child 崩溃但 outcome 未到；steer/abort 卡住 |
| Run 停在 waiting | pending_action | 审批/问答等待 Product 响应（Product Tools MCP 同步等待） |
| 输入发了但没执行 | branch_input_queue.status | 队列项未被 acquire（active run 占位）；delivery idempotency 冲突 |
| child crash / malformed stdout | agent_run.status + adapter 日志 | child 启动失败（CODING_AGENT_BIN）；JSONL 帧损坏；stdout 被污染 |
| 重复执行同一输入 | branch_input_queue delivery/input idempotency keys | 重投未命中幂等键；adapter 未记录 acceptance |
| Web 状态卡住不结束 | Live Updates 通道 | 事件流断连；terminal commit 已完成但 SSE 未推送（重连即可恢复） |
| 找不到历史执行明细 | agent_run + product_tool_call | 旧 span/attempt/control_plane_event 表已在 Phase 6 删除，不提供转换工具 |

## 关键不变式（违反即 bug）

- **Agent Run 是唯一执行身份**：没有 span/attempt/session。任何按 spanId/sessionId 的查询都已删除。
- **BackendRunOutcome 是终态唯一依据**：事件流永远不能决定 terminal state；只有 outcome（completed/failed/aborted/timeout）才提交产品事实。
- **terminal commit 原子性**：final assistant Message（`agent_run_id`）+ Context ref + branch 更新 + Run 终态在同一事务；失败则 Run 保持 commit_failed，幂等重试。
- **账本是唯一对话事实来源**：任何端（Web/飞书）若和账本不一致，错的是 surface 的 projection，不是账本。
- **子进程无状态**：child 崩溃 = 当前 Run failed；下一个输入 = 新 Run = 从 Agent Context full projection 重建。没有需要"恢复"的执行状态。

## 关联页面

- [事实与投影](../foundations/facts-and-projections.md)
- [Agent Run 输出与实时更新](../runs/output-and-live-updates.md)
- [后端总览](../backend/overview.md)
- [飞书](../surfaces/lark.md)
