# M1 Spec — loopReducer：Loop item 状态转移的纯函数

> **Status:** 🏗 Design → Implementation
> **Baseline:** 2026-07-01 HEAD，Loop 设计 wiki + ADR 0001–0004 锁定的决策。
> **关联:** `docs/architecture/foundations/loop.md`（状态机）· `docs/architecture/backend/loop-runner.md`（调用方）· `docs/adr/0001-loop-prune-is-post-processing.md` · `docs/adr/0003-state-md-single-writer.md` · `docs/adr/0004-discovery-is-agent-session.md`

**Goal:** 落地 `loopReducer(state, action) → state` 纯函数——整个 Loop 系统 item 状态转移的**唯一测试缝**。不读文件、不调 AgentSession、不碰网络。给定当前 state 和一个 action，返回新 state。

**Non-goals:**
- 不处理 STATE.md / INBOX.md 文件读写（M2）
- 不调用 AgentSession（M3）
- 不引入预算计数、写锁、并发限制（M4）
- 不解析 config.yml / constraints.md（M2）
- 不做 discovery 编排（M3）

---

## 1. 背景

Loop 的 item 走一条 `triaged → fixing → verifying → awaiting_review → resolved | inbox | promoted` 的状态机。人在 review queue 拍板、cron 触发 TICK、evaluator 出裁决——三条入口都会改 item 的 step。

这些转移必须收在一个纯函数里：同一组输入永远同一组输出，不依赖任何外部状态。这是整条`loopStep()` 编排链里唯一可单测、可重放的一环。所有后续实现（M2 文件读写、M3 AgentSession dispatch）都基于它。

## 2. 当前代码事实

1. **包结构**：`packages/loop/` 新包，与 `packages/harness/` 同级（L4），依赖只向下（core types）。
2. **测试**：`bun:test`，`*.test.ts` 与源文件同目录。
3. **TypeScript**：ESM + NodeNext，target ES2023，strict + `noUncheckedIndexedAccess`。
4. **无依赖**：不 import `@chengchenccc/harness`、`@chengchenccc/framework`、`@chengchenccc/core`——纯 TS 类型 + 纯函数。
5. **已有契约**：`loop-runner.md` 已定 `loopReducer` 签名 + 不变量；`loop.md` 已定 item step 状态机。

## 3. 第一性原则

1. **纯函数，零副作用**：`(state, action) → state`，不碰 I/O。可单测、可重放。
2. **不抛异常**：非法 action（错 step、空 evidence、不存在 itemId）返回原 state——绝不静默丢数据，也绝不崩溃调用方。
3. **不可变返回**：每次返回新 state 对象，不修改入参。
4. **reducer 只管 step 转移，不管清理**：prune 已终结 item（resolved/promoted）是 `loopStep()` 写回文件前的过滤，不是 reducer action（[ADR 0001](../adr/0001-loop-prune-is-post-processing.md)）。
5. **ADD_ITEM 拒绝 id 冲突**：不覆盖已有 item，返回原 state。id 由 `loopStep()` 用 ULID 生成（[ADR 0003](../adr/0003-state-md-single-writer.md)）。

## 4. 类型定义

```typescript
// === Item identity ===
type ItemId = string  // ULID, e.g. "01JN7X8K3M..."

// === Item step ===
type ItemStep =
  | "triaged"           // 等待处理
  | "fixing"            // generator 在修
  | "verifying"         // evaluator 在审
  | "awaiting_review"   // 等人拍板
  | "resolved"          // 人通过（终态，写回时 prune）
  | "inbox"             // 驳回/耗尽/升给（终态，写 INBOX.md）
  | "promoted";         // 移走（终态，写回时 prune）

// === Evaluator verdict ===
type Verdict =
  | { verdict: "PASS"; evidence: string }
  | { verdict: "REJECT"; reasons: string[]; evidence: string }
  | { verdict: "ESCALATE"; reasons: string[]; evidence: string };

// === Single item ===
type ItemState = {
  id: ItemId;
  source: string;          // "ci/4821", "issue/92", "manual", "eval/f-1"
  summary: string;         // 一行描述
  step: ItemStep;
  attempt: number;         // 当前尝试次数，从 1 起
  priority: number;        // 0 = 默认，越小越优先
  result: Verdict | null;  // 最近一次 evaluator 裁决
};

// === Loop state ===
type LoopState = {
  loopId: string;
  lastRun: string | null;  // ISO8601
  items: Record<ItemId, ItemState>;
};

// === Actions ===
type LoopAction =
  // cron 触发：triaged → fixing（全部）
  | { type: "TICK" }

  // generator 跑完：fixing → verifying，清 result
  | { type: "GENERATOR_DONE"; itemId: ItemId }

  // evaluator 出裁决：PASS → awaiting_review / L3→resolved
  //                   REJECT → fixing（attempt+1）/ inbox（耗尽）
  //                   ESCALATE → inbox
  | { type: "EVALUATOR_VERDICT"; itemId: ItemId; verdict: Verdict }

  // 人拍板
  | { type: "APPROVE"; itemId: ItemId }
  | { type: "REJECT_HUMAN"; itemId: ItemId; feedback?: string }
  | { type: "PROMOTE"; itemId: ItemId }

  // 从 inbox 捡回
  | { type: "RETRY"; itemId: ItemId }

  // 从 inbox 永久删除
  | { type: "DISMISS"; itemId: ItemId }

  // 加新 item（discovery / 手动 / evaluator spin-off）
  | { type: "ADD_ITEM"; item: Omit<ItemState, "step" | "attempt" | "priority" | "result">; priority?: number };
```

## 5. 状态转移表

### TICK

| 当前 step | → 新 step | 条件 |
|---|---|---|
| `triaged` | `fixing` | 无条件，全部推进 |

### GENERATOR_DONE

| 当前 step | → 新 step | 副作用 |
|---|---|---|
| `fixing` | `verifying` | `result ← null`，`attempt` 不变 |
| 其他 | 无操作 | — |

### EVALUATOR_VERDICT

| 当前 step | verdict | → 新 step | 副作用 |
|---|---|---|---|
| `verifying` | PASS | `awaiting_review` (L2) / `resolved` (L3) | `result ← verdict` |
| `verifying` | REJECT | `fixing` | `result ← verdict`, `attempt ← attempt + 1` |
| `verifying` | REJECT, attempt ≥ maxRetries | `inbox` | `result ← verdict` |
| `verifying` | ESCALATE | `inbox` | `result ← verdict` |
| `verifying` | PASS, evidence 为空或空白 | 无操作（不转移） | — |
| 其他 | — | 无操作 | — |

> `maxRetries` 由 `loopStep()` 传入，不存 ItemState。L2/L3 同理——reducer 接收 `opts?: { maxRetries?: number; autoResolve?: boolean }`。

### APPROVE

| 当前 step | → 新 step |
|---|---|
| `awaiting_review` | `resolved` |
| 其他 | 无操作 |

### REJECT_HUMAN

| 当前 step | → 新 step | 副作用 |
|---|---|---|
| `awaiting_review` | `inbox` | `result ← { verdict: "REJECT", reasons: [feedback ?? "手动驳回"] }` |
| 其他 | 无操作 | — |

### PROMOTE

| 当前 step | → 新 step |
|---|---|
| `awaiting_review` | `promoted` |
| 其他 | 无操作 |

### RETRY

| 当前 step | → 新 step | 副作用 |
|---|---|---|
| `inbox` | `triaged` | `attempt ← 1`, `result ← null` |
| 其他 | 无操作 | — |

### DISMISS

| 当前 step | → 新 step |
|---|---|
| `inbox` | 从 state 中删除 |
| 其他 | 无操作 |

### ADD_ITEM

| 条件 | 操作 |
|---|---|
| id 不存在 | 追加 item（step=`triaged`, attempt=1, priority=0, result=null） |
| id 已存在 | 无操作（拒绝冲突，返回原 state） |

## 6. 函数签名

```typescript
function loopReducer(
  state: LoopState,
  action: LoopAction,
  opts?: {
    maxRetries?: number;    // 默认 3
    autoResolve?: boolean;  // L3 模式：evaluator PASS 直接 resolved；默认 false (L2)
  }
): LoopState
```

## 7. 验收标准

1. **TICK**：所有 `triaged` → `fixing`；空 state 不变；非 triaged item 不动。
2. **GENERATOR_DONE**：`fixing` → `verifying`，result 置 null；非 fixing item 无操作。
3. **EVALUATOR_VERDICT PASS**（L2）：`verifying` → `awaiting_review`；evidence 空/空白 → 不转移。
4. **EVALUATOR_VERDICT PASS**（L3, `autoResolve:true`）：`verifying` → `resolved`。
5. **EVALUATOR_VERDICT REJECT**（attempt < maxRetries）：`verifying` → `fixing`，attempt+1。
6. **EVALUATOR_VERDICT REJECT**（attempt ≥ maxRetries）：`verifying` → `inbox`。
7. **EVALUATOR_VERDICT ESCALATE**：`verifying` → `inbox`。
8. **APPROVE**：`awaiting_review` → `resolved`；非 awaiting_review 无操作。
9. **REJECT_HUMAN**：`awaiting_review` → `inbox`，带反馈。
10. **PROMOTE**：`awaiting_review` → `promoted`。
11. **RETRY**：`inbox` → `triaged`，attempt 重置 1，result 清空。
12. **DISMISS**：`inbox` → 从 state 中删除。
13. **ADD_ITEM**：新 item 加入；id 冲突 → 拒绝，返回原 state。
14. **不存在的 itemId**：任意 action 指向不存在 id → 返回原 state。
15. **不抛异常**：所有边界输入不抛异常。
16. **不可变**：入参 state 不被修改；返回新对象。
17. **全 workspace typecheck / lint / test 通过**（M1 只有 `packages/loop`）。

## 8. 实施分组

| Patch | 内容 | 文件 |
|---|---|---|
| P1 | 建包骨架：package.json + tsconfig + index.ts barrel | `packages/loop/` |
| P2 | 类型定义：LoopState, ItemState, Verdict, LoopAction | `src/types.ts` |
| P3 | loopReducer 实现 | `src/loop-reducer.ts` |
| P4 | 测试：转移正确性 + 边界（空 evidence / 冲突 id / 错 step / 不存在 id） | `src/loop-reducer.test.ts` |
| P5 | 收尾：全 workspace 验证 + 包 README | `packages/loop/README.md` |

## 9. 风险

1. **TypeScript `noUncheckedIndexedAccess`**：`Record<ItemId, ItemState>` 的 property access 可能返回 `undefined`。实现须逐处 guard。
2. **不可变复制**：`items` 是 Record，浅拷贝后用 spread 增/删/改。注意 spread `{...items, [id]: newItem}` 不会触 prototype pollution。
3. **opts.maxRetries 默认值**：caller 不传时默认为 3。不做 item 级 override（per-item retry 差异延后到 P2）。
4. **DISSMISS 是唯一删 item 的非 prune 操作**：侧效只在 state.item 层面，不涉及文件删除（那是 M2 INBOX.md 的事）。
