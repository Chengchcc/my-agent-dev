---
id: conversation.history
title: Conversation History
status: design
owners: architecture
summary: "Conversation History 是所有成员共享的会话事实。人类和 Agent 的最终可见 Message 都进入 History；每个 Agent Member 的 Agent Context 保存其实际消费的稳定 Message 引用。"
depends_on:
used_by:
  - agents.context
  - runs.output-and-live-updates
  - surfaces.web
  - surfaces.lark
---

# Conversation History

Conversation History 回答一个问题：

```text
这场 Conversation 中，所有成员共同发生了什么？
```

它保存共享 Message 和明确的 Conversation 事件。Web、Lark 和 API 从 History 恢复用户可见内容；Agent Backend 的私有 session、thinking 或 Live Updates 不能替代它。

## History 保存什么

- 人类 Message；
- Agent 最终可见 Message；
- member joined/left；
- todo、artifact 等共享产品条目；
- 明确影响 Conversation 的控制事件。

History 不保存：

- token delta；
- 临时 thinking；
- provider raw event；
- model/tool latency；
- process 状态；
- Agent Backend 私有 transcript。

## 与 Agent Context 的关系

Conversation History 保存共享 Message 的唯一身份和内容。Agent Context 不复制 Message，只保存稳定引用，表达某个 Agent 在某条 Context Branch 上实际消费了哪些共享历史。

内部可以使用顺序号和 append-only table 实现这个引用关系，但这些字段不是公开领域概念。

## 人类 Message

人类 Message 写入 Conversation History 后立即对端可见。它不会立刻进入所有 Agent Context。

某个 Agent 被触发时，Product Backend 根据成员可见性、addressedTo、mention、trigger mode 和 context budget，选择这个 Agent 实际消费的 Message refs，并追加到当前 Context Branch。

未触发的 Agent 不积累无关 History。

## Agent Message

Agent Backend 的 Live Updates 只用于实时展示。收到 terminal `BackendRunOutcome` 后，Product Backend 在同一个数据库事务中：

```text
写最终 assistant Message 到 Conversation History
→ 将 Message ref 追加到 Agent Context
→ 更新 Context Branch
→ 更新 Agent Run terminal state
```

如果事务失败，Agent Run 不能被报告为完成。

## 实时更新与恢复

Web 可以按稳定 message/run identity 显示 Live Updates。终态 Message 写入 Conversation History 后，History 成为页面重连和跨 Surface 恢复的来源。

Live Updates 不需要永久堆积在 History。正在执行的工作从 Agent Run 状态恢复。

## 顺序与幂等

- Conversation History 定义共享顺序；
- terminal outcome 必须携带稳定 Agent Run identity；
- 同一个 Agent Run 的 terminal commit 必须幂等；
- History Message 与 Context ref 使用 run ID 或 idempotency key 防重复。

## Visibility

History 是共享事实，但并非每个 Agent 必须消费所有内容。同步到 Agent Context 前必须执行 visibility 过滤。

私有 Agent Context 不应为了方便写入共享 History。

## 不变量

1. Conversation History 是共享会话真源。
2. 人类和 Agent 最终可见 Message 使用同一个 Message 本体。
3. Live Updates 不定义 History 事实。
4. Agent Context 引用共享 Message，不复制内容。
5. 未触发 Agent 不自动消费消息。
6. Agent final Message 与 Context ref 原子提交。
7. Surface 不直接修改 Conversation History。

## 关联页面

- [Agent Context](../agents/context.md)
- [Agent Backend](../execution/agent-backend.md)
- [Agent Run 输出与实时更新](../runs/output-and-live-updates.md)
