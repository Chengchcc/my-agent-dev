# Plan: Canonical Message Contract — ledger 存完整 canonical 序列

**日期**: 2026-08-11
**Spec**: [2026-08-11-canonical-message-contract.md](../specs/2026-08-11-canonical-message-contract.md)
**ADR**: [0017-canonical-message-contract](../../adr/0017-canonical-message-contract.md)

## Wave 1: 协议层契约（`@my-agent-team/message`）

### Task 1.1: 新增 `canonical.ts`
- `normalizeCanonicalMessages(messages): Message[]`：assistant 混 tool_result → 拆成 assistant(kept) + tool(paired results)，孤儿丢弃，其余透传
- 类型：`Message`/`ContentBlock` 复用现有定义

### Task 1.2: 单元测试
- 混血拆分（assistant text+tool_use+tool_result → assistant(text+tool_use) + tool(tool_result)）
- 孤儿 tool_result 丢弃（无匹配 tool_use_id）
- 纯消息透传（user/assistant 无 tool_result/tool 消息不变）

### Task 1.3: 导出
- `packages/message/src/index.ts` 导出 `normalizeCanonicalMessages`

### Gate
- `cd packages/message && bun test && bun run typecheck`

## Wave 2: Outcome 协议序列化（`@my-agent-team/agent-backend` + adapter）

### Task 2.1: `BackendRunOutcome` 扩展
- 新增 `messages: Message[]`（run 产生的 canonical 序列）；`output` 保留兼容
- 更新 outcome 相关 schema/类型（`packages/agent-backend`）

### Task 2.2: Adapter 协议
- `packages/adapter-coding-agent/src/protocol.ts`：`OutcomeOutput` 加 `messages`
- rpc-fixture 同步

### Gate
- `cd packages/agent-backend && bun test && bun run typecheck`

## Wave 3: Runtime 输出（`packages/agent` + `apps/coding-agent`）

### Task 3.1: agent-loop 输出序列
- 删除当前"最后一条带文本 assistant"的 output 逻辑
- 返回该 run 新增的 canonical 消息序列（assistant(tool_use)/tool(tool_result)/assistant(text)，branch 顺序，过滤本轮输入之前的消息）

### Task 3.2: rpc-mode outcome 携带序列
- `apps/coding-agent/src/modes/rpc`：outcome 带 `messages`
- 更新 harness 测试（output.blocks 断言 → messages 断言）

### Gate
- `cd packages/agent && bun test`
- `cd apps/coding-agent && bun test`

## Wave 4: Backend 提交（`apps/backend`）

### Task 4.1: 迁移
- 手写 SQL：DROP `idx_ledger_agent_run`；ADD COLUMN `message_index`；CREATE UNIQUE `(agent_run_id, message_index)` WHERE agent_run_id IS NOT NULL
- 按 Phase 6 流程：journal 重命名、迁移文件编号对齐

### Task 4.2: `commitCompletedRun` 多消息
- 签名 `(runId, outcome, messages)`
- 先 `normalizeCanonicalMessages`（边界强制）
- 逐条写 ledger：`messageIndex`、messageId（assistant → `assistantMessageId(runId, ordinal)`；tool → `run:<runId>:tool:<index>`）、MessageRevisionSchema role 加 "tool"
- 幂等：`(run_id, message_index)` 冲突 no-op + seq 回读；每条一个 context ref + CAS branch
- 更新 execution.ts 调用点与 db.test.ts 保留 fixture

### Task 4.3: 后端测试
- 多消息提交：ledger 行数、顺序、messageId、message_index
- 重放幂等：同 `(run_id, index)` 不重复写
- `normalizeCanonicalMessages` 在提交入口生效（混血输入被拆）

### Gate
- `cd apps/backend && bun test`（全量）
- `bun run --filter=@my-agent-team/backend typecheck`

## Wave 5: Web UI（`apps/web`）

### Task 5.1: `isConclusionMessage` / `groupTurns`
- tool 消息恒非 conclusion；归入所在 turn 的 rounds
- 测试先行（conversation-reducer 测试）

### Task 5.2: 渲染验证
- ReasoningTrace 跨消息配对（应已工作）；Timeline 不渲染 tool 独立气泡

### Gate
- `cd apps/web && bun test && bun run typecheck`

## Wave 6: 清理 + 完整回归

### Task 6.1: 清理
- 确认 projection 拆解已 revert（backend 纯透传）
- anthropic serializer 拆解降级为存量防御（注释说明）
- 删除 `output` 兼容字段（若所有调用方已迁移）

### Task 6.2: 完整回归
- `bun run typecheck`（全仓）
- `bun run lint`（全仓）
- `bun run test`（全仓）
- `bun run --filter=@my-agent-team/web build`
- 浏览器实测：真实模型多轮对话，run 2+ 不再 400；ledger 有完整 canonical 序列；UI canonical trace 含工具结果

### Gate
- 以上全绿；无遗留 TODO/死代码
