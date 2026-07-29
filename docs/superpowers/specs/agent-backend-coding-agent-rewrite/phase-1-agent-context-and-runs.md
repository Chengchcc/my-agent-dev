# Phase 1：建立 Agent Context 与 Agent Run

## 目标

在 `backend.db` 中建立 Product Backend 的 canonical context 和执行控制面：Conversation History、Agent Context、Context Branch、BackendSessionState、Agent Run、持久输入队列和 PendingAction。

本 Phase 不调用 Runtime，也不双写旧 checkpointer。

## 不兼容策略

- 不迁移 `checkpoint_messages`、`checkpoint_interrupts`、`checkpoint_events` 为新事实。
- 不恢复旧 runtime session、active run 或 interrupt。
- 不保留 `member.session_id` 作为新 binding 来源。
- 不提供 Tree 与 MessageStore 双写。
- 旧 execution cache 直接视为无效；产品事实继续保留。
- 现有成员首次运行时创建默认 Tree/Branch，并按当前 Product Policy 从 Ledger 同步 context；不模拟旧 Agent 实际读过的历史。

## 约束

1. Ledger、Tree、Branch、Binding、Run 位于同一 `backend.db`。
2. 同一 Context Branch 最多一个 active Agent Run。
3. normal、steer、follow_up 先持久化，再投递。
4. Tree 不保存 streaming、thinking、process status。
5. Branch 内 backendKind 固定；切换 Backend 必须 fork。
6. Model change 是 Context entry，下一个 Agent Run 生效。

## 目标文件

修改 schema/migration：

```text
apps/backend/src/infra/db/schema.ts
apps/backend/src/infra/sqlite/db.ts
apps/backend/drizzle/backend/<next-migration>.sql
apps/backend/drizzle/backend/meta/_journal.json
```

新建：

```text
apps/backend/src/features/agent-context/{domain,ports,adapter-sqlite,service,index}.ts
apps/backend/src/features/agent-run/{domain,ports,adapter-sqlite,service,index}.ts
```

测试与 source 同目录。

## 数据模型

```text
agent_context_tree
agent_context_entry
agent_context_branch
backend_session_binding
agent_run
branch_input_queue
pending_action
```

Entry types：ledger_message、private_message、product_tool_exchange、summary、model_change。

必要约束：

- `(conversation_id, agent_member_id)` 唯一 Tree。
- active run partial unique index。
- queue 顺序 index：branch + createdAt + id。
- runId、productEntryId、delivery idempotency key 唯一。

## 实现步骤

1. 新建表和 migration；不读取 checkpoint 数据。
2. 实现 `getOrCreateTree`、`getOrCreateDefaultBranch`、entry append、model change、fork、move leaf、binding stale。
3. 实现 root-to-leaf projection，应用 summary，解析 Ledger ref，保留 productEntryId。
4. 实现 Agent Run 状态机、branch ownership CAS、queue claim/accept/deliver、PendingAction consume-once。
5. 实现原子 acquire command：branch CAS → Ledger visibility/window → append refs → ledgerCursor → create Run → revision。
6. acquire 失败只 enqueue，不修改 Tree。
7. 删除 persistence 层的 member session binding API；不提供兼容读取。

## 验收

- 空库和带现有 Ledger/Member fixture 的 migration 成功。
- 不依赖 `checkpointer.db`。
- 同 branch 并发 acquire 只有一个成功。
- 两个 Agent Member 的 Tree 隔离。
- Ledger Message 只存 ref。
- model_change 下一个 Run 生效。
- fork/rollback 不删除历史。
- projection 带稳定 productEntryId。
- 旧成员首次运行可创建默认 branch，不读旧 session。
- Backend restart 后 queue 顺序不变。
- accept 前 crash 可重新 claim。
- PendingAction consume-once。
- terminal outcome 按 runId 幂等。

## 完成条件

Product Backend 已有完整但尚未连接 Runtime 的 control plane。旧 execution 数据没有兼容入口，也没有双写路径。
