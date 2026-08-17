# ADR: Canonical Message Contract（ledger 存 canonical 序列）

**日期**: 2026-08-11
**状态**: accepted
**范围**: `@chengchenccc/message`（契约定义）、`@chengchenccc/agent-backend`（outcome 协议）、`packages/agent`（runtime 输出）、`packages/adapter-oma-agent`（adapter 映射）、`apps/backend`（ledger 提交 + 身份索引）、`apps/web`（tool 消息渲染）、`packages/ai`（provider 纯转换）

---

## 问题

### 1. ledger 里存在"混血消息"，回灌模型必炸

`agent-loop.ts` 的 canonical output 合并把 branch 里所有 `tool_use`/`tool_result` block 平铺进最后一条 assistant 消息：

```text
assistant: [text, tool_use, tool_result]
```

这条消息既是 UI 的 trace 载体，又被当真实历史回灌给模型。严格 validator（deepseek、z.ai）拒绝 `tool_result` 出现在 assistant 消息里：

```text
`tool_result` blocks can only be in `user` messages
```

### 2. 现有修法是消费方防御，不满足未来 adapter

- backend projection 拆解 + anthropic serializer 拆解：同一规则写两遍
- openai-compat provider 没覆盖（静默丢 tool_result → 孤儿 tool_calls）
- 每加一个 oma 类型 = 一个新的可能产出坏消息的生产者；每加一个 provider = 一个必须自己防御的消费者
- 复杂度随 adapter 数量线性增长，不收敛

### 3. 根因：合法性不是契约，是各消费方的自觉

`Message` 类型允许 `assistant + tool_result`，没有一处强制"模型可回灌"这一不变量。

## 决策

### 1. Canonical 消息契约（协议层，`@chengchenccc/message`）

| role | 允许内容 | 禁止 |
|------|---------|------|
| `user` | text、tool_result blocks | — |
| `assistant` | text、tool_use blocks | **tool_result** |
| `tool` | tool_result blocks（必须配对 `tool_use_id`） | — |

辅助函数（协议层单一实现）：

```typescript
// @chengchenccc/message
normalizeCanonicalMessages(messages: Message[]): Message[];
// assistant 含 tool_result → 拆成 assistant(tool_use) + tool(tool_result)（孤儿丢弃）
// 其余原样透传。形状驱动，与 agent 类型无关。
```

### 2. 边界强制：adapter 输出进入 ledger 前归一化

`commitCompletedRun` 是**所有 adapter 输出的唯一入口**。在此对 run 的消息序列做 `normalizeCanonicalMessages`：

- 一个点、对所有 oma 类型通用
- 换 adapter 不需要改 backend —— 契约由边界强制，不靠生产方自觉
- 归一化结果保证"ledger 里任何序列都能被任意 provider 直接回灌"

### 3. Provider 纯转换，不再有拆解

provider 只做 canonical → wire 的纯转换（`role:"tool"` 缓冲成 `user(tool_result*)`，anthropic serializer 已有）。anthropic 里对"assistant 混 tool_result"的拆解保留为**存量数据防御**（迁移前已入库的混血消息），不承担新数据职责。

### 4. Ledger 存完整 canonical 序列（方案 B）

一次 run 的提交不再是单条 final message，而是完整 canonical 序列：

```text
assistant(text + tool_use)   ← 各工具回合
tool(tool_result)            ← 每个工具结果
assistant(text)              ← 最终答案
```

- **模型跨轮上下文**：下一轮 history 保留完整工具过程（与 my-agent 同构：runtime 自跑 loop）
- **UI canonical trace**：从 ledger 直接重建（`ReasoningTrace` 已按跨消息配对实现，只差 `groupTurns` 把 tool 消息当 rounds）
- **工具 trace 持久化**：刷新不丢

### 5. 提交身份从"一 run 一行"改为"一 run 多行"

`conversation_ledger.agent_run_id` 唯一索引改为 `(agent_run_id, message_index)` 唯一：

- 重放幂等：并发/重试以 `(run_id, message_index)` 判重，冲突 no-op
- 每条提交消息按序打 `message_index`；assistant 消息沿用 `assistantMessageId(runId, ordinal)`，tool 消息用 `run:<runId>:tool:<index>`
- 迁移：DROP 旧唯一索引 + CREATE `(agent_run_id, message_index)` 唯一索引（手写 SQL，drizzle-kit 快照链落后已知）

### 6. runtime 输出 = canonical 消息序列

`agent-loop.ts` 不再合并 output；run 的 outcome 携带该 run 产生的全部 canonical 消息（assistant(tool_use)/tool(tool_result)/assistant(text)，天然是 branch 的自然形态）。之前的"output = 最后一条带文本的 assistant"作为过渡已被本方案取代。

## 不做

- 不把 tool 事件单独存 transcript（solo 风格）——我们与 my-agent 同构，history 必须带工具消息
- 不保留 projection 拆解——边界归一化取代它（已 revert）
- 不做 ledger 文本化降级（方案 A）

## 实现顺序

1. `@chengchenccc/message`：契约 + `normalizeCanonicalMessages`（Wave 1）
2. `@chengchenccc/agent-backend`：outcome 携带消息序列（Wave 2）
3. `packages/agent`：runtime 输出 canonical 序列（Wave 3）
4. `packages/adapter-oma-agent` + `apps/oh-my-agent`：序列透传（Wave 3）
5. `apps/backend`：多消息提交 + 身份索引迁移（Wave 4）
6. `apps/web`：`groupTurns`/`isConclusionMessage` 支持 tool 消息（Wave 5）
7. 完整回归：typecheck + lint + 全量测试 + web build + 浏览器多轮实测（Wave 6）

## 目标架构

```text
adapter 边界                     ledger（canonical 序列）        provider
┌───────────────────┐   ┌────────────────────────┐   ┌────────────────┐
│ oma X    │   │ user                    │   │ 纯转换          │
│ → run 消息序列     │ → │ assistant(tool_use)     │ → │ tool→user       │ → wire
│ （canonical）      │   │ tool(tool_result)       │   │ （无拆解）       │
│ normalizeCanonical│   │ assistant(text)         │   │                │
└───────────────────┘   └────────────────────────┘   └────────────────┘
        ↑ 边界唯一强制点              ↑ 任意 provider 可直接回灌
```

**不变量**

- INV-1：ledger 中任何消息序列可直接回灌任意 provider（canonical 合法）
- INV-2：`normalizeCanonicalMessages` 是混血消息唯一归一化实现（协议层）
- INV-3：backend/UI 不感知 agent 类型；新 adapter 只实现边界协议
- INV-4：一 run 的 ledger 行按 `(agent_run_id, message_index)` 唯一，重放幂等
