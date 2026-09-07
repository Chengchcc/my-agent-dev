---
id: flows.e2e-web-message
title: Web 消息端到端
status: current
owners: architecture
summary: "Web 消息流：写入 Conversation History → 触发 Agent Run → Adapter spawn 一次性 oma 子进程 → streaming 只做实时投影 → terminal outcome 后原子提交 Ledger 与 Tree。"
depends_on:
  - surfaces.web
  - runs.output-and-live-updates
  - agents.context
  - execution.oma-backend
used_by:
---

# Web 消息端到端

本页用一条 Web 消息串起 Product Backend、Agent Context 和 Agent Backend 的边界。

## 时序

```mermaid
sequenceDiagram
  participant U as 用户
  participant W as Web
  participant P as Product Backend
  participant L as Conversation History
  participant T as Agent Context
  participant S as Agent Runs
  participant A as Agent Backend
  participant K as oma child

  U->>W: 发送消息 / @Agent
  W->>P: POST Conversation Message
  P->>L: 追加人类 Message
  L-->>W: Ledger SSE 确认
  P->>P: trigger / visibility / branch 选择
  P->>S: CAS 获取 branch run ownership
  P->>T: 同事务同步 Ledger refs + 创建 Agent Run
  S->>A: execute(full projection + input + run snapshot)
  A->>K: spawn --mode rpc + execute command
  K-->>A: stream events
  A-->>P: core BackendEvents
  P-->>W: transient SSE delta/status
  K-->>A: terminal outcome
  A-->>P: BackendRunOutcome
  P->>P: 原子 Product commit
  P->>L: 最终 assistant Message（agent_run_id）
  P->>T: ledgerSeq ref + branch leaf/revision
  P->>S: 标记 Run terminal + 释放 branch lock
  L-->>W: canonical Ledger SSE
```

## 人类 Message

Web 可以先显示乐观消息，但 Product Backend 写入 Conversation History 后才形成共享事实。Ledger SSE 使用稳定 message identity 与乐观消息对账。

## Agent 触发与 Tree 同步

Backend 根据 trigger mode、mention、addressedTo、权限和 branch 选择目标 Agent。

消息发送时不会立即复制到所有 Agent Tree。目标 Agent 真正启动 Agent Run 时，Backend 根据 `ledgerCursor` 查询尚未消费的可见 Ledger entries，并按照统一 N 条或 token budget 选择最近历史，追加 refs 到当前 branch。

更早上下文通过 Product History MCP 渐进加载；只有显式 retain 才永久追加到 Tree。

## Agent Runs

同一 branch 同时最多一个 active run。空闲则立即 acquire；否则输入进入 normal、steer 或 follow-up 持久队列（`branch_input_queue`），每个 Run 都是**全量投影**——不存在 execution session 查找或 resume。

获取 branch run ownership、同步 Ledger refs、推进 cursor 和创建 Agent Run 是同一事务。无法获得 ownership 的输入进入队列，不能并发修改 Tree。

## Streaming

Adapter 把子进程事件映射为 Product Backend 核心事件（`mapRunEvent`）。Web 实时显示 text、thinking、tool 和 status，但这是 transient projection，不写 canonical Tree。`backend.oma.*` 事件可以显示在诊断 UI，但产品逻辑不依赖它。

## Terminal commit

只有 terminal `BackendRunOutcome` 决定 Agent Run 终态。Completed 时，Backend 在同一事务完成：

```text
Ledger final Message（agent_run_id 唯一提交标记）
Tree ledger_message ref
branch leaf/revision
Agent Run completed（terminal_result）
```

事务成功后 Web 从 Ledger SSE 收到 canonical Message，branch lock 才释放。事务失败 → Run 停在 commit_failed，幂等重试。

## Steer 与 follow-up

- normal、steer、follow-up 都先进入持久产品队列；
- steer 由 Adapter 立即转发给 live child（`steer` command）；
- follow-up 始终等待当前 Agent Run terminal 后开启新 Run（新子进程）；
- 子进程内部 sub-agent 不创建额外 Agent Run。

## 失败与恢复

| 场景 | 恢复方式 |
|---|---|
| Web 断线 | 从 Ledger 重放已提交历史，从 Agent Run 状态恢复执行 UI |
| child crash / malformed output | 当前 Run failed（保留诊断）；下一个输入 = 新 Run = 从 Agent Context 重建 |
| Streaming delta 丢失 | 不影响 canonical history |
| Product commit 失败 | Agent Run 进入 commit_failed，保存 terminal outcome；幂等重试 commit，成功前不释放 branch |
| Branch rollback | 下一个 Run 从新 branch 投影，无需"重建 session" |

## 不变量

1. Web 不是事实来源。
2. Ledger 保存共享历史，Tree 保存该 Agent context。
3. Streaming 不是 canonical history。
4. Terminal outcome 是完成依据。
5. Ledger 与 Tree terminal commit 原子。
6. Agent Run 是唯一执行身份；child 状态可丢失，Agent Context 不可丢失。

## 关联页面

- [系统总览](../system-overview.md)
- [Conversation History](../conversation/history.md)
- [Agent Run 输出与实时更新](../runs/output-and-live-updates.md)
- [Agent Context](../agents/context.md)
- [Agent Backend](../execution/agent-backend.md)
