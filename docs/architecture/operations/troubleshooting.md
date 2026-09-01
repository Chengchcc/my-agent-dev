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
- 缓存/投影：一次性 oma 子进程（transcript/stderr）、Live Updates/SSE。

事实错了影响所有端；执行层问题影响某个 Run 的终态；投影问题只影响某个端的视图。

## 症状对照

| 症状 | 先看哪里 | 根因方向 |
|---|---|---|
| 某成员看不到本该有的消息 | `conversation_ledger` 该 conversation 的 entries | 消息没写入账本；SSE fan-out 失败；前端投影没跟上 |
| 所有人都缺同一条消息 | 账本 + agent_run terminal_result | terminal commit 事务失败（Run 停在 commit_failed）；child 没产出 final Message |
| Run 卡在 running 不动 | agent_run.status + child 进程 | execute 未被接受（queue 停在 delivering）；child 崩溃但 outcome 未到；steer/abort 卡住 |
| Run 停在 waiting | pending_action | 审批/问答等待 Product 响应（Product Tools MCP 同步等待） |
| 输入发了但没执行 | branch_input_queue.status | 队列项未被 acquire（active run 占位）；delivery idempotency 冲突 |
| child crash / malformed stdout | agent_run.status + adapter 日志 | child 启动失败（OMA_BIN）；JSONL 帧损坏；stdout 被污染 |
| 重复执行同一输入 | branch_input_queue delivery/input idempotency keys | 重投未命中幂等键；adapter 未记录 acceptance |
| Web 状态卡住不结束 | Live Updates 通道 | 事件流断连；terminal commit 已完成但 SSE 未推送（重连即可恢复） |
| 找不到历史执行明细 | agent_run + product_tool_call | 旧 span/attempt/control_plane_event 表已在 Phase 6 删除，不提供转换工具 |

## 关键不变式（违反即 bug）

- **Agent Run 是唯一执行身份**：没有 span/attempt/session。任何按 spanId/sessionId 的查询都已删除。
- **BackendRunOutcome 是终态唯一依据**：事件流永远不能决定 terminal state；只有 outcome（completed/failed/aborted/timeout）才提交产品事实。
- **terminal commit 原子性**：final assistant Message（`agent_run_id`）+ Context ref + branch 更新 + Run 终态在同一事务；失败则 Run 保持 commit_failed，幂等重试。
- **账本是唯一对话事实来源**：任何端（Web/飞书）若和账本不一致，错的是 surface 的 projection，不是账本。
- **子进程无状态**：child 崩溃 = 当前 Run failed；下一个输入 = 新 Run = 从 Agent Context full projection 重建。没有需要"恢复"的执行状态。

## 诊断日志（OMA_DEBUG=1）

设置 `OMA_DEBUG=1`（Backend 环境；子进程继承同一开关）后，Backend 终端会输出一条端到端生命周期链，用于定位卡在哪个阶段。日志只含阶段名、id、计数与状态——**不含消息正文、工具输入、prompt 或密钥**；child stderr 也会被脱敏后实时转发。

最短观察链（缺哪一行，故障就在上一行与下一行之间）：

```text
[conversation] trigger conversationId=... mode=normal runId=... acquired=true
[agent-run] context_projected runId=... entries=7
[oma-adapter] spawned runId=... pid=...
[oma] loop_live runId=...
[oma] model_start runId=... turn=1 model=...
[oma-adapter] outcome runId=... status=completed
[agent-run] terminal_commit runId=... output=true
```

失败会带阶段：

```text
[agent-run] dispatch_failed runId=... stage=context_projection Error: ...
```

tag 含义：`conversation`（触发与入队）、`agent-run`（执行生命周期）、`oma-adapter`（spawn/JSONL/回收）、`oma`（child RPC 与 model/tool loop）。

### 前端需要观察的两个 SSE

浏览器 Network 应同时存在：

- `GET /api/bff/api/conversations/:conversationId/events` —— canonical final Message（terminal commit 后推送）；
- `GET /api/bff/api/agent-runs/:runId/events` —— 临时 text/tool/status 事件。

⟩
定位口诀：Conversation SSE 无事件 → 查前端 hook/BFF 问题；两个 SSE 都在但 Run SSE 无事件 → 查 adapter/child 日志；Run SSE 有 `completed` 但 Conversation SSE 无 assistant Message → 问题在 terminal commit。

## 关联页面

- [事实与投影](../foundations/facts-and-projections.md)
- [Agent Run 输出与实时更新](../runs/output-and-live-updates.md)
- [后端总览](../backend/overview.md)
- [飞书](../surfaces/lark.md)
