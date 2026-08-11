# Spec: Canonical Message Contract — ledger 存完整 canonical 序列

**日期**: 2026-08-11
**ADR**: [0017-canonical-message-contract](../adr/0017-canonical-message-contract.md)

## Problem

一次 run 的 canonical output 把 `tool_use`/`tool_result` 合并进最后一条 assistant 消息，ledger 存下"混血消息"。下一轮 run 投影回灌时被严格模型 API（deepseek、z.ai）以 `tool_result blocks can only be in user messages` 拒绝。现有 consumer 侧拆解（projection + anthropic serializer）随 adapter/provider 数量线性膨胀，不满足长期主义。

## Goal

- **契约不变量**：ledger 里任何消息序列可直接回灌任意 provider
- **单一归一化点**：混血消息只在一个协议层函数里处理，backend 与 provider 不再各自防御
- **完整序列**：一次 run 在 ledger 里留下 `assistant(tool_use)` / `tool(tool_result)` / `assistant(text)` 的完整 canonical 记录，模型跨轮上下文与 UI trace 都从它重建
- **换 adapter 零 backend 改动**：边界强制，不靠生产方自觉

## Design

### 1. Canonical 消息契约（`@my-agent-team/message`）

```typescript
// role 语义
type CanonicalRole = "user" | "assistant" | "tool" | "system";

// 合法 block 组合
// user:       [text*] | [tool_result*]
// assistant:  [text*, tool_use*]   ← 永不 tool_result
// tool:       [tool_result*]（tool_use_id 必须存在）
```

**归一化函数**（协议层唯一实现，形状驱动，与 agent 类型无关）：

```typescript
// @my-agent-team/message/src/canonical.ts
export function normalizeCanonicalMessages(messages: readonly Message[]): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    if (m.role === "assistant" && m.blocks?.some((b) => b.type === "tool_result")) {
      // 拆：assistant 保留 text/tool_use；tool_result 按 tool_use_id 配对成独立 tool 消息
      // 孤儿（无匹配 tool_use_id）丢弃
      const toolUseIds = new Set(m.blocks.filter((b) => b.type === "tool_use").map((b) => b.id));
      const results = m.blocks.filter(
        (b) => b.type === "tool_result" && b.tool_use_id !== undefined && toolUseIds.has(b.tool_use_id),
      );
      const kept = m.blocks.filter((b) => b.type !== "tool_result");
      if (kept.length > 0) out.push({ ...m, blocks: kept });
      if (results.length > 0) out.push({ role: "tool", blocks: results });
      continue;
    }
    out.push(m);
  }
  return out;
}
```

### 2. Outcome 协议：单消息 → 消息序列（`@my-agent-team/agent-backend`）

`BackendRunOutcome` 当前 `output: Message | undefined`。扩展为携带序列：

```typescript
interface BackendRunOutcome {
  status: "completed" | "failed" | ...;
  /** Run 产生的 canonical 消息序列（不含输入）。assistant(tool_use)/tool(tool_result)/assistant(text)，按序。 */
  messages: Message[];   // 新增；output 保留作兼容/兜底（首条 assistant 文本）
  output?: Message;
  ...
}
```

- `packages/adapter-coding-agent/src/protocol.ts`：`OutcomeOutput` 同样扩展
- `apps/coding-agent` rpc-mode：outcome 携带 session 该 run 的 branch 消息（输入之外）
- 兼容：`output` 继续存在（老调用方/测试），新提交路径优先用 `messages`

### 3. Runtime 输出（`packages/agent/src/runtime/agent-loop.ts`）

- 删除 output merge（当前已改为"最后一条带文本的 assistant"，本方案取代）
- run 结束返回该 run **新增的** canonical 消息序列：
  - 各回合 `assistant(tool_use)`（source=assistant）
  - 各工具结果 `tool(tool_result)`（source=tool_result）
  - 最终 `assistant(text)`
- 顺序 = branch 内该 run 的持久化顺序（`readBranchMessages` 过滤本轮输入之前的消息）

### 4. Backend 提交（`apps/backend/src/features/agent-run/adapter-sqlite.ts`）

`commitCompletedRun(runId, outcome, output)` → `commitCompletedRun(runId, outcome, messages)`：

- 对 `messages` 先过 `normalizeCanonicalMessages`（边界唯一强制点）
- 逐条写入 `conversation_ledger`：
  - `agentRunId: runId` + `messageIndex: 0..n`
  - `messageId`：assistant → `assistantMessageId(runId, ordinal)`；tool → `run:<runId>:tool:<index>`
  - `MessageRevisionSchema` role union 扩展 `"tool"`
- 身份/幂等：`(agent_run_id, message_index)` 唯一；冲突 no-op（重放安全），seq 从既有行回读
- Context ref：每条提交消息追加一个 `ledger_message` ref + CAS branch revision（保持现有事务语义）
- `assistantMessageId` 现有 ordinal 语义保持不变

### 5. 迁移（`apps/backend/drizzle/backend/`）

```sql
-- 0019/0020 追加（手写，drizzle-kit 快照链落后已知）：
DROP INDEX IF EXISTS `idx_ledger_agent_run`;
CREATE UNIQUE INDEX `idx_ledger_agent_run_message` ON `conversation_ledger` (`agent_run_id`, `message_index`) WHERE agent_run_id IS NOT NULL;
ALTER TABLE `conversation_ledger` ADD COLUMN `message_index` integer;
```

存量混血行不动（provider 拆解兜底）；新写入全走 canonical。

### 6. Web（`apps/web/src/lib/conversation-reducer.ts` + 组件）

- `isConclusionMessage`：`role === "tool"` 的消息恒非 conclusion（当前 text 空 + 无 tool_use 会误判为 conclusion）
- `groupTurns`：tool 消息归入其所在 turn 的 `rounds`（不打断 turn，不开启新 turn）
- `Timeline`/`ReasoningTrace`：无需新组件 —— `ReasoningTrace` 的 `resultMap` 已跨消息收集 `tool_result`，tool 消息进 rounds 后自动配对
- `MessageActions`/bubble：tool 消息不渲染独立气泡（trace 内展示）

### 7. Provider（`packages/ai`）

- anthropic serializer：保留 `role:"tool"` → `user(tool_result)` 缓冲（已实现）；"assistant 混 tool_result"拆解保留为存量数据防御
- openai-compat：`role:"tool"` → `role:"tool"`（OpenAI 原生 tool 消息格式）；不再需要处理混血（边界已保证）

## 关键风险

| 风险 | 缓解 |
|------|------|
| `(agent_run_id, message_index)` 索引迁移与既有提交逻辑冲突 | 迁移先于代码切换；提交事务内先插后读 seq，冲突 no-op 语义保持 |
| MessageRevisionSchema 不支持 role "tool" | schema role union 扩展；web reducer 同步 |
| 存量混血消息在迁移后回灌 | provider 拆解保留为防御 |
| tool 消息进入 SSE/UI 造成渲染回归 | `groupTurns` 测试先行（TDD），浏览器实测兜底 |

## 验收

1. `normalizeCanonicalMessages` 单测：混血拆分、孤儿丢弃、透传
2. `commitCompletedRun` 多消息提交 + 重放幂等（同 `(run_id, index)` 冲突 no-op）
3. `groupTurns`：tool 消息进 rounds，不误判 conclusion
4. 多轮真实模型 run：run 2+ 不再 400；ledger 含完整 canonical 序列；UI canonical trace 从 ledger 重建且含结果
5. 完整回归：typecheck / lint / 全量测试 / web build 全绿
