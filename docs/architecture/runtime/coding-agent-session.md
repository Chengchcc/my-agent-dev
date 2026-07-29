---
id: runtime.coding-agent-session
title: Coding Agent Session
status: design
owners: architecture
summary: "Coding Agent Session 使用 append-only Coding Session Tree 持久化 message、compaction 和 todo entries，并用独立 operation log 持久化 leaf movement。每个 live session 由独立 worker 承载，Product history 以 projected entries 幂等同步，Coding Session Tree 只作为可重建执行缓存。"
depends_on:
  - runtime.coding-agent
used_by:
  - runtime.coding-agent-prompt
---

# Coding Agent Session

Coding Agent Session 是自研 Coding Runtime 的持久执行缓存。它支持 native resume、compaction、worker crash recovery 和内部调试，但不是 Agent Context 的替代品。

## 它和 Agent Context 有什么区别

```text
Agent Context
  = canonical product context
  = branch/fork/rollback source

Coding Session Tree
  = Coding Agent execution cache
  = model/tool transcript + runtime compaction + todo
```

Agent Context 的 branch 变化可以使 execution session state stale；Coding Session Tree 的任何变化都不能创建或修改 Context Branch。

## Session 保存在哪里

```text
runtime-data/
└── sessions/
    ├── <session-id>.sqlite
    └── ...
```

Daemon 通过 session ID 定位文件，并在内存维护 live worker registry。首版不建立独立 catalog 数据库；需要跨 session 查询达到实际性能瓶颈后再增加索引。每个 session SQLite 文件只被一个 live worker 写入，降低锁竞争并隔离损坏。

Runtime core 依赖 `SessionStore` port，首版实现：

```text
InMemorySessionStore
SqliteSessionStore
```

未来更换存储不修改 Agent Loop。

## Coding Session Tree 保存什么

Coding Session Tree 是 append-only tree，每个 entry 包含：

```ts
interface CodingSessionEntryBase {
  id: string;
  parentId: string | null;
  createdAt: number;
  loopId?: string;
}
```

首版 entry 集合：

```ts
type CodingSessionEntry =
  | MessageEntry
  | CompactionEntry
  | TodoStateEntry;

type CodingSessionOperation =
  | { type: "leaf_moved"; targetEntryId: string | null; createdAt: number };
```

### MessageEntry：模型可读取的消息

```ts
interface MessageEntry extends CodingSessionEntryBase {
  type: "message";
  message: Message;
  source:
    | "product_history"
    | "meta"
    | "prompt"
    | "steer"
    | "assistant"
    | "tool_result";
  productEntryId?: string;
}
```

`productEntryId` 用于 Product → Runtime 增量同步幂等。Runtime 已存在相同 `productEntryId` 时跳过。

### CompactionEntry：Runtime 内部摘要

保存 Runtime 内部 summary、覆盖范围、tokensBefore 和 retained tail。原始 entries 不删除，active context 从最新有效 CompactionEntry 重建。

### TodoStateEntry：当前 todo 状态

Todo 是 Runtime-local helper。每次 todo 更新追加 `TodoStateEntry`；恢复时扫描当前 branch 最新状态。Todo entry 默认不作为普通 transcript message 发送模型，而是由当前 todo reminder/meta provider 注入。

### leaf_moved：移动当前分支位置

Active leaf change 是 durable `leaf_moved` operation，不是语义 context entry。Session metadata 缓存 latest leaf 以便快速打开；cache 丢失时可从 operation log 重建。移动 leaf 和追加新 entry 需要串行执行，避免并发 append 从同一个旧 leaf 形成意外 sibling。

## 新 Agent Loop 如何写入输入

每个新 Agent Loop 开始时，Adapter 提交一个原子输入批次：

```text
0..N projected Product history messages
1 Meta User Message
1 Actual Prompt
```

SessionStore 必须保证批次全写或全不写，并在最后一次更新 active leaf。Retry 同一 loop 不重新追加该批次。

Steer 属于当前 loop，追加 `source=steer` message；Follow-up 开启新 loop，因此会生成新的 Meta User Message 和 Prompt。

## Product history 如何增量同步

Adapter 根据 Context Branch binding 的同步点传入新增 `ProjectedHistoryItem`。Runtime 将它们转换成 `source=product_history` MessageEntry，并保存 `productEntryId`。

如果 execution session 丢失，则新 Coding Session 从 Context Branch 当前线性投影初始化。Coding Session Tree 不复制 Agent Context 的 branch 结构；Context Branch fork 创建新 Coding Session。

## 模型和 System Prompt 如何切换

System Prompt 不作为 Coding Session Tree entry；每个 Agent Loop 使用 `AgentRunSnapshot` 中的 System Prompt，并在 loop metadata 记录 `systemPromptHash`。

Context Branch 的 ModelChangeEntry 决定 effective model。Coding Session 可以跨 loop 切换 model，但当前 active loop 使用 Agent Run 启动时的模型快照。Coding Session Tree 不保存 ModelChangeEntry；恢复时 Adapter 重新传入当前有效 model。

## SessionStore 接口

```ts
interface SessionStore {
  create(metadata: CodingSessionMetadata): Promise<void>;
  open(sessionId: string): Promise<CodingSessionSnapshot | null>;
  appendBatch(sessionId: string, entries: readonly NewCodingSessionEntry[]): Promise<AppendResult>;
  moveLeaf(sessionId: string, targetEntryId: string | null): Promise<void>;
  readBranch(sessionId: string): Promise<readonly CodingSessionEntry[]>;
  findByProductEntryIds(sessionId: string, ids: readonly string[]): Promise<ReadonlySet<string>>;
  delete(sessionId: string): Promise<void>;
}
```

SQLite adapter 在一个 transaction 中写 entries、`leaf_moved` operation 和 metadata leaf cache。

## 上下文过大时如何压缩

三类触发共用一个 operation：

```text
threshold
context overflow recovery
manual
```

Compaction 从 active Coding Session branch 计算 token-aware cut point，生成 summary，写 CompactionEntry，更新 leaf。Provider overflow 自动压缩后最多 retry 一次，避免无限压缩循环。

## Worker 退出后如何恢复

```text
session requested
→ Daemon 检查 live worker
→ alive: send command
→ asleep: start new worker and open SessionStore
→ crashed: mark current Agent Run failed
→ next Product request starts a new Agent Run from Agent Context
```

Idle session 可 sleep：关闭 worker，不删除 SQLite session。再次调用时新 worker 恢复已完成的 branch、todo 和 compaction，然后执行新的 Agent Loop。

Worker crash 不恢复原 active loop。可能存在的未完成 assistant/tool entries 只用于诊断，不进入新的 active context；Product Backend 将 execution session binding 标记 stale，并从 Agent Context 重建新的 Coding Session。

## 不变量

1. Coding Session Tree 不是 Product canonical history。
2. 每个 session 同时最多一个 writer worker。
3. 每个 session 同时最多一个 active Agent Loop。
4. Loop input batch 原子追加。
5. Product history 通过 productEntryId 幂等同步。
6. Leaf change 可从 append-only operation log 重建。
7. Retry 不重复追加 input。
8. System Prompt 不写 Tree；Meta Message 写 Tree。
9. 原始 entries 不因 compaction 删除。
10. Context Branch fork 创建新 Coding Session，不操作 Runtime 内部分支。

## 关联页面

- [Coding Agent](./coding-agent.md)
- [Coding Agent Prompt 与 Context](./coding-agent-prompt.md)
- [Agent Context](../agents/context.md)
