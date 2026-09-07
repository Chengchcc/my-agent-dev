# ADR 0001: Prune 是写文件前过滤，不是 reducer action

## 状态

Accepted

## 上下文

Loop 的 item 有三个终态：`resolved`、`inbox`（驳回/耗尽）、`promoted`。

- `resolved` / `promoted`：纯终结，留在 STATE.md 没意义，应清理
- `inbox`：人驳回或返工耗尽的 item，人未来可能想捡回来继续跑，不应消失

prune 作为 reducer action 还是后处理：
- **A**：`PRUNE` 作为 reducer action，在状态转移层删除终态 item
- **B**：prune 是 loopStep() 写 STATE.md 前固定过滤步骤，不走 reducer

## 决策

**选 B**。prune 是存储清理，不是状态转移。

**写入终态分流**：`inbox` 不留在 STATE.md，而是写到单独文件 INBOX.md：

```
.loop/
  STATE.md    ← 流水线中的 item（triaged → fixing → verifying → awaiting_review）
              ← resolved / promoted 在写回前 prune
  INBOX.md    ← 被驳回的 item（永久保存，等人捡回来）
```

- STATE.md prune 规则：删 `resolved` + `promoted`；`inbox` item 不写回 STATE.md
- `inbox` item 追写到 INBOX.md（追加，不覆盖：多次驳回同 id 保留最新一条）
- `RETRY { itemId }` action：从 INBOX.md 删除该 item → 写回 STATE.md（step=triaged, attempt=1）
- loopReducer 管 step 转移，不管文件写回；prune 和 INBOX.md 写入是 loopStep() 的职责

## 后果

- loopReducer 多一个 action type：`RETRY`
- loopReducer 少一个 action type：`PRUNE`
- 多一个文件 INBOX.md（与 STATE.md 格式相同，只包含 inbox item）
- review queue 从 STATE.md 读 awaiting_review item，从 INBOX.md 读被驳回 item（同一张列表）

## 关联

- [Loop Engineering](../architecture/foundations/loop-engineering.md)
- [设计哲学](../architecture/design-philosophy.md) — 机制（清理）不能上浮成业务心智（状态转移）
