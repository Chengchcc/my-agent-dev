---
id: foundations.facts-and-projections
title: 事实与投影
status: design
owners: architecture
summary: "目标架构区分三类状态：Conversation History 是共享会话事实，Agent Context 是单个 Agent Member 的上下文事实，Execution session 是可丢弃执行缓存。Streaming、thinking、process status 和 provider 原始事件都是投影或诊断，不定义产品历史。"
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

`Message` 仍然是唯一消息领域类型。Ledger、Tree、Runtime 和 Surface 不各自发明不同的 Message；它们只保存引用、包装生命周期或转换协议。

```text
Message
  ├─ 在 Conversation History 中作为共享会话事实
  ├─ 在 Agent Context 中通过 ledgerSeq 被某 Agent context 引用
  ├─ 被 Adapter 转换为 Runtime-native input
  └─ 被 Web/Lark 渲染
```

## 三种状态

### Conversation History：共享事实

Ledger 记录所有成员可见的 Conversation 内容，包括人类与 Agent 的最终 Message、成员事件和产品控制条目。它决定用户看到的共享历史。

### Agent Context：Agent 上下文事实

Tree 的 scope 是 `(conversationId, agentMemberId)`。它决定该 Agent 在某条 branch 上实际消费过什么、保留了哪些 Product Tool 结果、应用了什么 Product Summary，以及从哪个历史节点继续。

共享 Message 在 Tree 中保存 `ledgerSeq` 引用，不复制 Message 内容。

### Execution session：执行缓存

Claude Code session、Codex thread、OpenCode session 和 Coding Agent Session 都是 opaque cache。它们可以保存 provider context、内部 compaction、tool state 和 sub-agent，但不能成为产品事实。

Execution session 丢失时，Product Backend 从 Agent Context active branch 投影线性 `ProjectedHistoryItem[]` 重建。

## 事实、缓存、投影和审计

| 类型 | 示例 | 可作为产品恢复真源 | 可重建 |
|---|---|---:|---:|
| 共享事实 | Conversation History | 是 | 否 |
| Agent 上下文事实 | Agent Context | 是 | 否 |
| Runtime cache | backendSessionId、live process、provider transcript | 否 | 是 |
| 实时投影 | streaming delta、typing/status、SSE buffer | 否 | 是 |
| 执行审计 | model/tool latency、usage、raw provider diagnostic | 否 | 通常否，但不参与语义恢复 |

## Message 何时成为产品事实

### 人类 Message

```text
写 Ledger
→ 端可见
→ Agent 被触发时按实际消费追加 Tree ledgerSeq refs
```

### Agent Message

```text
Agent Backend streaming events
→ transient UI projection
→ terminal BackendRunOutcome
→ 同一事务写 Ledger + Tree ref + branch leaf/revision
```

Streaming delta 不写 canonical history。只有 terminal assistant Message 才提交。

## Product Tool 结果何时进入 Context

Agent Backend 原生工具由 Runtime 自己执行，其原始 tool lifecycle 属于 runtime events。Product Tool 由 Product Backend 执行。

只有满足以下条件的 Product Tool call/result 才进入 Agent Context：

```text
后续模型需要读取
或用户需要理解其因果
或切换 Runtime 时必须保留
```

通知、presence、heartbeat、queue status 和 UI refresh 只进投影或审计。

## Product Summary 和 Runtime compaction 有什么区别

Product Summary 是 Tree entry，由 Product Policy 和可插拔 summarizer 生成。它只改变 context projection，原始历史保留。

Runtime compaction 是 Claude/Codex/OpenCode/Coding Agent 的内部缓存优化，不写 Agent Context，也不改变产品历史。

## 为什么更早历史按需加载

Branch metadata 保存 `ledgerCursor`。触发时 Backend 从 cursor 之后筛选该 Agent 可见的 Ledger entries，并按统一 N 条或 token budget 追加最近历史。

更早历史通过 Product History MCP 读取。读取默认是当前 Agent Run 临时 tool result；只有显式 retain 才追加到 Tree。

## 为什么 Ledger 和 Agent Context 都需要

Ledger 回答：

```text
Conversation 中所有成员共同发生了什么？
```

Tree 回答：

```text
这个 Agent 在这条 branch 上实际知道什么？
```

如果只保留 Ledger，就难以表达每个 Agent 的私有上下文、工具语义、summary 和 branch。如果只保留 Tree，就失去多人共享顺序、统一可见性和端侧恢复事实。

二者通过 `ledgerSeq` 引用连接，而不是复制 Message。

## 不变量

1. Message 领域类型只有一处定义。
2. Conversation History 是共享会话 canonical store。
3. Agent Context 是单 Agent Member 的 context canonical store。
4. Execution session 永远不是产品事实。
5. Streaming、thinking 和运行状态不进入 canonical history。
6. Ledger Message 与 Tree terminal ref 原子提交。
7. Product Summary 不删除历史。
8. Event/ops 数据不能替代 Ledger 或 Tree。
9. Surface 只能渲染或提交命令，不能成为事实来源。

## 关联页面

- [系统总览](../system-overview.md)
- [Conversation History](../conversation/history.md)
- [Agent Context](../agents/context.md)
- [Agent Backend](../execution/agent-backend.md)
- [数据模型](../backend/data-model.md)
