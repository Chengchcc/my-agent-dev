---
id: foundations.facts-and-projections
title: 事实与投影
status: current
owners: architecture
summary: "三类状态：Conversation History 是共享会话事实，Agent Context 是单个 Agent Member 的上下文事实，Run-time 状态（子进程 transcript、streaming、Live Updates）是可丢弃缓存或投影。只有 terminal BackendRunOutcome 才原子提交产品事实。"
depends_on:
used_by:
  - architecture.system-overview
  - backend.overview
  - agents.context
  - backend.data-model
---

# 事实与投影

本页回答：系统中哪些数据可以作为产品决策和恢复依据，哪些只是执行缓存、实时展示或诊断记录。

## 单一 Message 本体

`Message` 仍然是唯一消息领域类型（`@my-agent-team/message`）。Ledger、Runtime 和 Surface 不各自发明不同的 Message；它们保存引用、包装生命周期或转换协议。

```text
Message
  ├─ 在 Conversation History 中作为共享会话事实（serializeMessageRevision）
  ├─ 在 Agent Context 中通过 ledgerSeq 被某 Agent context 引用
  ├─ 经 Adapter 投影成子进程的 input history
  └─ 被 Web/Lark 渲染
```

## 三种状态

### Conversation History：共享事实

Ledger 记录所有成员可见的 Conversation 内容：人类与 Agent 的最终 Message、成员事件和产品控制条目。它决定用户看到的共享历史。

### Agent Context：Agent 上下文事实

Tree 的 scope 是 `(conversationId, agentMemberId)`。它决定该 Agent 在某条 branch 上实际消费过什么、保留了哪些 Product Tool 结果、应用了什么 Product Summary，以及从哪个历史节点继续。共享 Message 在 Tree 中保存 `ledgerSeq` 引用，不复制内容。

### Run-time 状态：执行缓存与投影

```text
一次性 coding-agent 子进程
  = 该 Run 的执行缓存（model/tool transcript、compaction、todo）
  = 子进程退出即销毁，永不跨 Run 复用
```

Streaming delta、Live Updates、子进程 stderr 都是投影/诊断，不进入 canonical history。

## 事实、缓存、投影和审计

| 类型 | 示例 | 可作为产品恢复真源 | 可重建 |
|---|---|---:|---:|
| 共享事实 | Conversation History | 是 | 否 |
| Agent 上下文事实 | Agent Context | 是 | 否 |
| 执行缓存 | 子进程 transcript、in-memory SessionStore、compaction | 否 | 是 |
| 实时投影 | streaming delta、status、SSE buffer | 否 | 是 |
| 执行审计 | surface_health、agent_run 终态、product_tool_call | 否 | 否（但保留为事实记录） |

注意：`agent_run` 的 terminal_result 与 `product_tool_call` 是持久审计事实，但它们不参与 context build —— 语义恢复只依赖 Ledger + Tree。

## Message 何时成为产品事实

### 人类 Message

```text
写 Ledger
→ 端可见
→ Agent 被触发时按实际消费追加 Tree ledgerSeq refs
```

### Agent Message

```text
child streaming events
→ transient UI projection（Live Updates）
→ terminal BackendRunOutcome
→ 同一事务写 Ledger（agent_run_id）+ Tree ref + branch leaf/revision
```

Streaming delta 不写 canonical history。只有 terminal assistant Message 才提交。

## Product Tool 结果何时进入 Context

Coding Agent 的 native tools 由子进程自己执行，其原始 tool lifecycle 属于 runtime events。Product Tool 由 Product Backend 执行，语义变更类调用写 `product_tool_call`（幂等/审计）。

只有满足以下条件的 Product Tool call/result 才进入 Agent Context：

```text
后续模型需要读取
或用户需要理解其因果
或下一个 Run 必须保留
```

通知、presence、heartbeat、queue status 和 UI refresh 只进投影或审计。

## Product Summary 和 Runtime compaction 有什么区别

Product Summary 是 Tree entry（`type=summary`），由 Product Policy 与 summarizer 生成。它只改变 context projection，原始历史保留。

Runtime compaction 是 Coding Agent 子进程内部的执行缓存优化（下一个 Run 不继承），不写 Agent Context，也不改变产品历史。

## 为什么每次都是 full projection

子进程没有持久状态；每个新 Run 从 active Context Branch 投影**完整**线性 `ProjectedHistoryItem[]`（按 branch 的可见性与预算筛选），而不是增量同步。这样：

- 不需要同步点、不需要 session 绑定、不需要 resume；
- 子进程 crash 后下一个 Run 从同一 Context 干净重建；
- `ledgerCursor` 仍用于推进 Tree 的消费进度，但子进程拿到的永远是全量投影。

更早历史通过 Product History Tool 渐进读取；只有显式 retain 才追加到 Tree。

## 不变量

1. Message 领域类型只有一处定义。
2. Conversation History 是共享会话 canonical store。
3. Agent Context 是单 Agent Member 的 context canonical store。
4. 子进程状态永远不是产品事实。
5. Streaming、thinking 和运行状态不进入 canonical history。
6. Ledger Message 与 Tree terminal ref 原子提交。
7. Product Summary 不删除历史。
8. ops/audit 数据不能替代 Ledger 或 Tree。
9. Surface 只能渲染或提交命令，不能成为事实来源。

## 关联页面

- [系统总览](../system-overview.md)
- [Conversation History](../conversation/history.md)
- [Agent Context](../agents/context.md)
- [Agent Backend](../execution/agent-backend.md)
- [数据模型](../backend/data-model.md)
