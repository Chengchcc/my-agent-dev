---
id: operations.troubleshooting
title: 排障手册
status: current
owners: architecture
last_verified_against_code: 2026-07-28
depends_on:
  - foundations.facts-and-projections
  - backend.conversation-projection
  - backend.overview
used_by:
---

# 排障手册


## 先分层，再定位

遇到问题，先问一句：这是**事实**坏了，or the **projection** is broken？

- 账本（conversation_ledger）和执行事实流（EventLog 的 checkpoint_events，按 spanId 切）是 durable 事实；
- ledger entries、SSE 流是投影；
- checkpointer.db 同时持有执行恢复状态（messages/interrupts）与执行事实流（events），由 split persistence ports（MessageStore + EventLog + InterruptStore）分别写入。

事实错了影响所有端，projection is wrong只影响某个端/某个成员的视图。这一刀切下去，排查范围立刻缩小。

## 症状对照

| 症状 | 先看哪里 | 根因方向 |
|------|----------|----------|
| 某成员看不到本该有的消息 | 该成员的 ledger entries（thread_id = conversationId:memberId） | `broadcastMessage` fan-out 失败；thread 推导错；账本其实有、投影缓存没跟上 |
| 所有人都缺同一条消息 | 对话账本 + 执行事实流 | `onRunMessage` 直写失败（critical，会抛错）；或 Agent 没产出该 message 事件 |
| 飞书收到重复消息 | 飞书适配器 `canSkipFinalLedgerText` | 首次投递必发的特性叠加终稿重发；去重条件未命中 |
| Web 状态卡在 running doesn't complete | run_done → run_finalized 握手 | completion sequence某步未完成；delta 订阅未关闭 |
| 运行崩溃后无法恢复 | checkpointer.db | 中断状态未 interruptStore.saveInterrupt，或被 interruptStore.consumeInterrupt 重复消费 |
| Agent 活没干完就停 | task-guard / maxForceContinues | 强制继续已用满 3 次；待办状态没正确标 done |

> 关于「卡住的 run」与心跳：`attempt` 表的 `pid` / `heartbeat_at` 和心跳 reaper 是 runner daemon 时代的存活探测残骸（daemon 在独立进程里跑，backend 靠心跳判断它是否失联）。Agent 改为进程内执行后已无「独立进程失联」这种中间态，这两列标 `deprecated`、reaper 仅作兜底。诊断卡住的执行时，优先看进程内的 span 是否真在推进（`checkpoint_events` 是否还在按 spanId 追加），而不是盯心跳列--心跳超时只说明「兜底触发了」，不指向根因。导航与收敛方向见 [未来工作](../roadmap/future-work.md)。

## 关键不变式（违反即 bug）

排障时拿这几条当标尺，违反了基本就是根因：

- **message 事件直写账本、非消息执行事件进 checkpoint_events**：`message` 事件经 `onRunMessage`（critical, awaited）直写对话账本；非消息执行事件（tool_start/tool_end/llm_call）由 agent runtime (span-loop) 经 `eventLog.appendEvent(sessionId, spanId, …)` 写入 EventLog 的 `checkpoint_events`。若看到 assistant 消息出现在 checkpoint_events 里，或对话账本缺了某条 assistant 消息，说明分流被破坏。
- **run_done completion sequence固定**：更新 attempt/run → 关闭 delta 订阅 → 从 `#active` 移除 → 发 run_finalized（控制信号优先）→ fire-and-forget onRunComplete。任一步乱序都可能导致悬挂或重复。
- **账本是唯一对话事实来源**：任何端（Web/飞书）若和账本不一致，错的是the surface's projection，不是账本。

## 关联页面

- [事实与投影](../foundations/facts-and-projections.md)
- [会话投影](../backend/conversation-projection.md)
- [后端总览](../backend/overview.md)
- [飞书适配器](../surfaces/lark-adapter.md)
