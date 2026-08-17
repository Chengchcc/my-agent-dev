---
id: agents.context
title: Agent Context
status: design
owners: architecture
summary: "Agent Context 表示一个 Conversation 中某个 Agent 实际知道什么。它引用共享 Message，保存私有语义、Product Tool 结果、Summary、Model change 和 Context Branch。"
depends_on:
  - conversation.history
  - foundations.facts-and-projections
used_by:
  - architecture.system-overview
  - execution.oma-backend
  - flows.e2e-web-message
---

# Agent Context
> ⚠ **部分过时(2026-08-13)**:本页以"同一 Conversation 内多 Agent 各自消费历史"为出发点;ADR 0021 后一个对话只有一个 Agent,Context 是单 Agent 的语义历史投影。机制(fork/rollback/branch)不变,前提简化。现行模型见 [Agent 工作区与多后端](./workspace-and-backends.md)。

Agent Context 解决一个产品级问题：同一个 Conversation 中，不同 Agent 实际消费的历史并不完全相同；同一个 Agent 还需要 fork、rollback、切换 branch 和可逆 summary。这个能力必须跨所有 Agent Backend 保持一致，因此属于 Product Backend。

## 一份 Context 属于谁

Agent Context 的稳定 scope 是：

```text
(conversationId, agentMemberId)
```

同一个 Agent 在不同 Conversation 中拥有不同 Context；同一 Conversation 中不同 Agent Member 也拥有不同 Context。

## Context 与 Conversation History 的分工

Conversation History 是所有成员共享的会话事实；Agent Context 表示某个 Agent 实际消费和产生的语义历史。

共享 Message 不复制内容，只保存稳定引用。内部 `LedgerMessageEntry` 和 parent-linked tree 是持久化方式，不改变 Message 本体。

## Context 保存什么

```ts
type AgentContextEntry =
  | LedgerMessageEntry
  | PrivateMessageEntry
  | ProductToolExchangeEntry
  | ProductSummaryEntry
  | ModelChangeEntry;
```

### Shared Message reference

引用 Conversation History 中的共享 Message。

### PrivateMessageEntry

保存只属于该 Agent 上下文、但需要跨 Agent Backend 恢复的语义内容。例如产品生成的私有约束或显式 retain 的非共享资料。它不能被用来绕开 Conversation 权限。

### ProductToolExchangeEntry

保存语义相关的 Product Tool call/result。只有影响后续模型判断或用户理解的工具交换才进入 Tree。通知、心跳、presence、状态刷新等控制面噪音不进入 Tree。

### ProductSummaryEntry

```ts
interface ProductSummaryEntry {
  type: "summary";
  id: string;
  parentId: string | null;
  summary: string;
  coversThroughEntryId: string;
  createdAt: number;
}
```

Summary 只改变上下文投影，不删除原始历史。回退到 summary 之前的节点时，原始 entries 仍然存在。

### ModelChangeEntry

Context Branch 允许在 Agent Loop 边界切换模型，因此模型变化是 Agent Context 的一等语义事件：

```ts
interface ModelChangeEntry {
  type: "model_change";
  id: string;
  parentId: string | null;
  model: BackendModelRef;
  createdAt: number;
}
```

当前 active run 不受影响；下一个 Agent Run 使用 active branch 上最后一个 ModelChangeEntry。没有该 entry 时使用 Product Agent 的 defaultModel。ModelRef 必须属于 branch 固定的 backendKind。

## Context Branch

Context Branch 是从某个历史节点继续工作的路径。内部 entries 使用 `parentId` 形成 tree，以支持 fork 和 rollback。

```ts
interface ContextBranch {
  id: string;
  treeId: string;
  leafEntryId: string | null;
  ledgerCursor: number;
  backendKind: string;
  backendSessionState?: BackendSessionState;
  revision: number;
}
```

`backendKind` 在 branch 创建时固定。branch 内禁止切换 Agent Backend。Fork 默认继承父 branch 的 backend，也允许创建新 branch 时显式选择另一个 backend。

### Run-time 状态（子进程内，非 Context 语义）

Agent Run 没有持久 execution session：每次执行由 Adapter spawn 一次性 oma 子进程，子进程内的 in-memory SessionStore 是该 Run 的私有缓存（`sessionId = runId`），Run 结束即销毁。没有 binding、没有同步点、没有原生 resume —— 下一个 Run 永远从当前 Context Branch 的 full projection 重建。

> 历史版本（daemon/session 架构）曾允许「binding 匹配则 resume」；Phase 5/6 已删除该路径，`backend_session_binding` 表与 resume 语义不复存在。

## 启动 Agent Run 时如何避免并发写入

触发、History 同步、Agent Run 创建和 branch ownership 获取必须属于同一个 Product Backend command。顺序是：先以 branch revision 做 CAS，再追加本轮要消费的 Message refs、推进 cursor、创建 active Agent Run。任何并发触发只能进入持久 input queue，不能同时修改 Context。

## Agent 触发时同步哪些 History Message

这里的 `visibility` 指 Product Backend 判断某条 History entry 是否能进入该 Agent 的 Context；`context budget` 指最近消息数量或 token 上限，不由 Agent Backend 私自决定。

人类消息先写 Conversation History，不立即复制到所有 Agent Tree。某 Agent 被实际触发时，Product Backend 才同步它要消费的历史：

1. 从 branch 的 `ledgerCursor` 之后读取 Ledger；
2. 按成员身份、visibility、addressedTo 和产品规则筛选；
3. 在统一 N 条或 token 预算内选择最近的语义消息；
4. 将选中消息的 `ledgerSeq` 按顺序追加到当前 branch；
5. 推进 `ledgerCursor`。

未触发的 Agent 不积累无关上下文。

## 如何按需读取更早历史

更早的可见 Ledger 历史由 Product History MCP 提供。Agent 可以搜索和读取历史，但读取默认只生成当前 Agent Run 的 tool result，不永久修改 Tree。

当 Agent 明确调用 retain/add-to-context 时，Product Backend 才将选定 `ledgerSeq` 引用追加到 Tree。这样能避免一次搜索永久膨胀后续上下文。

## 如何构建 Runtime 输入

Agent Backend 不接收 Tree。Product Backend 从 active branch 构造线性语义历史：

```text
root-to-leaf entries
→ 找到 latest applicable Product Summary
→ 用 summary 替代其覆盖范围
→ ledger refs 解析为 Message
→ 合并 private messages 与 retained Product Tool exchanges
→ 应用统一 Product context budget
→ Message[]
```

Adapter 再将 `ProjectedHistoryItem[]` 转成 Claude Code、Codex、OpenCode 或自研 Runtime 的 native input。

## 如何 fork 或 rollback

### Fork

Fork 在指定 entry 处创建新 Context Branch。默认继承 `backendKind`，也允许显式选择另一 backend。新 branch 不继承 live `backendSessionId`，而是从分叉点的线性语义历史创建新的 execution session。

### Rollback / move leaf

移动 active leaf 不修改或删除历史。因为 Runtime 内部 context 已不再与 Context Branch 一致，现有 execution session state 必须标记 stale；下一次执行从新 active branch 恢复或重建。

### Binding 失效原则

只有在当前 leaf 尾部追加新语义 entry 才属于快进，可以增量同步。任何非快进结构变化都使 binding 失效，包括 rollback、move leaf、fork、新 Summary 改变投影范围，以及历史可见性修正。

## Agent 输出如何原子提交

Agent Backend streaming delta 只用于 transient projection。收到 terminal `BackendRunOutcome` 后，Product Backend 在同一个数据库事务中：

1. 写最终 assistant Message 到 Conversation History；
2. 取得 `ledgerSeq`；
3. 将 `LedgerMessageEntry` 追加到当前 Context Branch；
4. 更新 branch leaf 和 revision；
5. 更新 execution session state 同步点。

如果事务失败，Ledger 和 Tree 都不提交，Agent Run 不能被报告为产品级完成。

### Terminal commit 失败

Adapter 已完成但 Product 事务失败时，Runtime 可能已经领先于 canonical Tree。此时必须：

1. 将 Agent Run 标记为 `commit_failed`，保存可幂等重放的 terminal outcome；
2. 将 execution session state 标记 `stale`，禁止继续向该 session 发送下一 Agent Run；
3. 重试同一个 terminal commit，幂等 key 使用 `runId`；
4. commit 成功后更新同步点；若最终无法提交，则 close/detach execution session，下次从 Agent Context 重建。

不能因为 Runtime 已完成就释放为 succeeded，也不能继续使用领先的 execution session。

## Product Summary 如何改变 Context

Product Summary 由 Product Backend 的统一策略触发，生成器是可插拔 summarizer。所有 Agent Backend 消费同一个 Product Summary，因此切换 backend 不会改变已提交历史的语义。

Agent Backend 仍可进行内部 context compaction，但那只是可丢弃缓存，不写入 Agent Context。

## 同一 Branch 如何排队执行

同一个 Context Branch 同时最多一个 active run。Normal、steer 和 follow-up 都先进入持久产品队列：

- Adapter 支持原生 steer 时，可在当前 Agent Run 中加速转发；
- 不支持时，steer 在安全 run boundary 作为下一输入；
- follow-up 始终等待当前工作自然结束后再发送；
- Agent Backend 内部可自由运行 sub-agent，它们仍属于同一 Agent Run。

## 不变量

1. Tree scope 是 `(conversationId, agentMemberId)`。
2. Ledger 是共享消息事实；Tree 是该 Agent 的上下文事实。
3. Tree 不复制共享 Message 内容，只引用 `ledgerSeq`。
4. Model 只看到 active branch 的线性投影。
5. Branch 内 Agent Backend 固定；切换 backend 必须 fork。
6. execution session state 是可重建 metadata，不是 canonical history。
7. 获取 branch ownership、同步 Ledger refs 和创建 Agent Run 必须原子。
8. Normal、steer、follow-up 是持久队列，不因 Product Backend crash 丢失。
9. Streaming delta 不进入 Tree。
10. Product Summary 不删除原始 entries。
11. 未实际触发的 Agent 不自动积累 Ledger 历史。
12. Ledger 与 Tree 的 assistant terminal 提交必须原子；commit_failed 时 execution session state 必须 stale。

## 关联页面

- [系统总览](../system-overview.md)
- [Agent Backend](../execution/agent-backend.md)
- [Conversation History](../conversation/history.md)
- [事实与投影](../foundations/facts-and-projections.md)
- [Web 消息端到端](../flows/e2e-web-message.md)
