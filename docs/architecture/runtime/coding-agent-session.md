---
id: runtime.coding-agent-session
title: Coding Agent Session（Run-local 执行缓存）
status: current
owners: architecture
summary: "Runtime 的 SessionStore（packages/agent）是 per-Run、in-memory 的执行缓存：seed 时原子写入 full Product history + meta + input，loop 跑完后随子进程销毁。无 SQLite session 文件、无 worker、无跨 Run 恢复。"
depends_on:
  - runtime.coding-agent
used_by:
  - runtime.coding-agent-prompt
---

# Coding Agent Session（Run-local 执行缓存）

Coding Agent Runtime 的状态是 **per-Run、in-memory** 的。它是该 Run 的执行缓存，不是产品历史，也不跨 Run 存在。

## 它和 Agent Context 有什么区别

```text
Agent Context
  = canonical product context（agent_context_tree/entry/branch）
  = 跨 Run 持久、可 fork/rollback

Runtime SessionStore
  = 单次 Run 的执行缓存（messages + todo + compaction 摘要）
  = 子进程退出即销毁；下一个 Run 重新 seed full projection
```

## Session 保存在哪里

`packages/agent/src/persistence/` 提供 `SessionStore` port 与 in-memory 实现（`createInMemorySessionStore`）。没有 SQLite session 文件、没有 catalog、没有 worker registry。

`createCodingAgentRuntime()` 在 Run 开始时以 `sessionId = runId` 创建 session：

```text
seed：full Product history（projected entries）
    + Meta User Message
    + Actual Prompt
    → 原子 appendBatch
→ loop 在 session 上跑（assistant/tool_result/todo 追加）
→ outcome 产出后 Runtime.close() → store 销毁
```

同一 Run 内的 retry 复用同一 session（input batch 不重复追加）；steer 向 live loop 追加 `source=steer` 消息。follow-up 是**新的 Agent Run**，因此是新的子进程、新的 session、新的 full seed。

## SessionStore 接口（简化）

```ts
interface SessionStore {
  create(metadata): Promise<void>;
  open(sessionId): Promise<CodingSessionSnapshot | null>;
  appendBatch(sessionId, entries): Promise<AppendResult>;
  moveLeaf(sessionId, targetEntryId): Promise<void>;
  readBranch(sessionId): Promise<readonly CodingSessionEntry[]>;
  findByProductEntryIds(sessionId, ids): Promise<ReadonlySet<string>>;
  delete(sessionId): Promise<void>;
}
```

- `productEntryId` 保留在 Runtime 追加的 entries 上，保证同一 canonical Message 不重复持久化（只在本次 Run 内有效）。
- Todo 是 Run-local helper：`TodoStateEntry` 存当前 todo 状态，由 todo reminder/meta provider 注入。
- Compaction 写 `CompactionEntry`（summary + 覆盖范围 + retained tail），原始 entries 不删除；仅影响本次 Run 的 active context。

## 上下文过大时如何压缩

阈值 / context overflow recovery / manual 三类触发共用 compaction：从 active branch 计算 token-aware cut point，生成 summary，更新 leaf。Provider overflow 自动压缩后最多 retry 一次。

## 子进程退出后

```text
outcome 已产出 → child 自行退出 → session 销毁
child crash    → 当前 Run failed；下一个输入 = 新 Run = 新子进程 = 从 Agent Context full projection 重建
```

没有任何东西需要恢复：产品事实只在 Ledger + Agent Context，执行缓存永远可丢。

## 不变量

1. Runtime SessionStore 不是 Product canonical history。
2. Session 是 per-Run、in-memory；不跨 Run 复用。
3. 同一 Run 最多一个 active loop；retry 不重复追加 input batch。
4. Product history 通过 `productEntryId` 在 Run 内幂等。
5. 原始 entries 不因 compaction 删除。
6. follow-up 开启新 Run：新子进程 + 新 session + 新 full seed。
7. Context Branch fork 由 Product Backend 管理，不操作 Runtime 内部状态。

## 关联页面

- [Coding Agent](./coding-agent.md)
- [Coding Agent Prompt 与 Context](./coding-agent-prompt.md)
- [Agent Context](../agents/context.md)
