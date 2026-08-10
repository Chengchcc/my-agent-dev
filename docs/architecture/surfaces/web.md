---
id: surfaces.web
title: Web 端
status: current
owners: architecture
last_verified_against_code: 2026-06-22
summary: "Web 端是浏览器里的对话界面。消费 conversation SSE，在 conversation-reducer 里按 messageId upsert 到 items[]。items 是 UiItem 联合（message / notice）。busy 从 open message 的 state 推导。"
depends_on:
  - conversation.history
  - runs.output-and-live-updates
used_by:
  - flows.e2e-web-message
  - operations.troubleshooting
---

# Web 端

Web 端是浏览器里的对话界面。它开启一个 SSE 连接到 `/api/bff/conversations/:id/events`，接收 [ledger](../conversation/history.md) 推送的条目。reducer 按 `messageId` upsert 到 `items[]`（`UiItem` 联合：`message` 和 `notice` 两种 kind）。busy 从 open message 的 `state` 字段推导——state 为 `streaming` 或 `waiting` 时表示 Agent 仍在运行或等待审批。

## ConvState

```ts
{
  viewerMemberId: string,
  roster: Record<string, SenderRef>,        // SenderRef.kind: "agent" | "human"
  items: UiItem[],                          // { kind: "message"; id; sender; content: Message }
                                            // | { kind: "notice"; id; text: string }
  streamConn: "connecting" | "open" | "reconnecting" | "closed",
  error: string | null,
  optimisticSeq: number,
  triggerMode: "auto" | "mention",
  todos: Array<{ step, status: "pending" | "in_progress" | "done" }>,
  pendingSendCount: number
}
```

Actions：`bootstrap`、`member`、`message`、`send`、`conn`、`toggleTriggerMode`、`send/error`、`todo/update`。

## SSE 事件类型

- `message` → `parseRevision(seq, content)` 解出 `ConversationMessageRevision`，按 `messageId` upsert
- `member.joined` / `member.left` → `member` action，`kind: "notice"` 的 UiItem
- `todo` → `todo/update` action

连接没有 idle timeout。后端每 ~15s 发 SSE comment `: ping\n\n` keepalive。terminal 状态不靠 `event: done`，靠 message revision 的 `state: "done"` / `state: "error"`。

## busy 推导

```ts
export function isBusy(s: ConvState): boolean {
  if (s.pendingSendCount > 0) return true;
  return s.items.some(
    (item) =>
      item.kind === "message" &&
      item.sender.kind === "agent" &&
      item.content.state != null &&
      isOpenMessageState(item.content.state),
  );
}
```

`ConversationCanvas` 用 `busy` 控制动画点、状态标签（"Running" / "Awaiting Approval"）。

## 关键纯函数

- `upsertAuthoritative`：同 messageId 就替换；否则对自己消息替换最近乐观消息（`opt-` 前缀）；再否则追加。
- `isConclusionMessage`：有非空 text 且无 tool_use block 即为 conclusion。
- `groupTurns`：连续同 Agent 消息收成一个 `turn`，`conclusion` 取最后一条 conclusion，其余进 `rounds`。

## Timeline 锚点

锚点放在 human 发言边界上。Agent turn 经 `ReasoningTrace` 渲染，不带锚点。notice 段独立渲染，不参与 turn 分组。纯 Agent→Agent 链以 sender-change 边界兜底。

## 失败模式

- 乐观消息残留：ledger echo 丢失时 `opt-` 消息不会被替换；messageId 不匹配时持久消息重复显示。
- streaming 文本不刷新：revision messageId 和前序不一致导致独立消息。
- 缺 reasoning：`reasoning_delta` 端到端产生，适配器从 thinking block 发出。不需要就上游去掉。
- 轮询抖动：不稳定 effect 依赖重建 interval。

## 关联页面

- [对话账本](../conversation/history.md)
- [会话投影](../runs/output-and-live-updates.md)
- [Web 消息端到端](../flows/e2e-web-message.md)
- [排障手册](../operations/troubleshooting.md)
