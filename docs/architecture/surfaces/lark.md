---
id: surfaces.lark
title: 飞书
status: current
owners: architecture
last_verified_against_code: 2026-06-16
summary: "飞书把飞书的群/用户映射成对话/成员，把入站消息 POST 给后端，通过 sse-watcher 消费 conversation ledger SSE 中的 MessageRevision 决定流式/最终可见文本。sse-watcher 是唯一出站流入口。去重依赖 revision 的 messageId + canSkipFinalLedgerText。"
depends_on:
  - conversation.history
  - runs.output-and-live-updates
used_by:
  - flows.e2e-lark-message
  - operations.troubleshooting
---

# 飞书
> ⚠ **部分过时（2026-08-13）**：ADR 0021 后不再建 human 成员（human 消息为对话外部事件）；「群/用户映射成对话/成员」简化为群映射成单 Agent 对话。

飞书把飞书的群/用户映射成对话/成员，把入站消息 POST 给后端，通过 sse-watcher 消费 conversation ledger SSE 中的 MessageRevision 决定流式/最终可见文本。sse-watcher 是唯一出站流入口。去重依赖 revision 的 messageId + canSkipFinalLedgerText。

## 这页解决什么问题

飞书是外部 IM，有 chat_id、用户、卡片、消息投递规则、webhook/event 语义。后端不该被这些细节绑死。飞书在飞书与后端对话概念之间做翻译。

## 入站流

```mermaid
sequenceDiagram
  participant LU as 飞书用户
  participant Bot as 飞书 Bot (ingest.ts)
  participant B as Backend
  participant C as Conversation Service

  LU->>Bot: 群消息 / @机器人
  Bot->>Bot: 按 event_id/message_id 幂等占位 reserveInbound
  opt 新会话
    Bot->>B: POST /api/conversations（含 agent 和 human 成员）
    Bot->>B: POST /conversations/:id/members（建 human 成员）
  end
  opt 已有会话
    Bot->>Bot: getMemberBinding 无则本地分配 memberId、写绑定，不 POST
  end
  Bot->>C: POST /messages（content 带 larkEventId/larkMessageId）
  C->>C: 触发 Agent，confirmInbound 回填 ledger_seq
```

成员 id 形如 `human:lark:${sender_id}`。建成员路径**区分新会话与已有会话**：新会话路径在 `POST /api/conversations` 后调 `POST /conversations/:id/members` 建成员再写绑定；已有会话路径仅本地分配 memberId + `putMemberBinding`，不调 `/members` API。这样已有会话里新出现的飞书用户不会产生多余的 HTTP 往返。`addressedTo`：单聊为 `[selfAgentId]`；群聊仅当 `isBotMentioned` 才为 `[selfAgentId]`，否则 `[]`（缺 botDisplayName 时 fail-closed）。

## 出站流

```mermaid
sequenceDiagram
  participant B as Backend
  participant Bot as 飞书 Bot
  participant L as 飞书

  B-->>Bot: 账本 message (sse-watcher)
  Bot->>Bot: parseRevision → ConversationMessageRevision
  Bot->>Bot: state === "streaming" → 渐进渲染文本
  B-->>Bot: 账本 message（同 messageId，state: done）
  Bot->>Bot: canSkipFinalLedgerText?
  Bot->>L: 不能跳过则发最终文本
```

`sse-watcher` 是唯一出站流入口。它连接到 conversation ledger SSE，解析每个 entry 的 MessageRevision，根据 `state` 字段决定出站行为。

## Revision state 驱动出站逻辑

`sse-watcher` 用 `parseRevision` 解析账本 entry 的 content 为 `ConversationMessageRevision`。`state` 字段驱动出站行为：

- `state === "streaming"`：run 仍在进行。sse-watcher 可将文本渐进渲染为 streaming 消息（更新同一 message），但不发最终文本。
- `state === "done"`：terminal revision。到达时查 `canSkipFinalLedgerText`——首次必发一次最终文本（`completeFromLedger` 尚为 0），重连重放时可跳过。
- `state === "error"`：run 失败。发错误文本。

`streaming` 仅用于渐进渲染，`done`/`error` 触发最终投递。

## 去重难题与 canSkipFinalLedgerText

```ts
export function canSkipFinalLedgerText(run: RunStreamRecord): boolean {
  return (
    run.status === "done" &&
    !!run.larkMessageId &&
    run.cardSendFailed === 0 &&
    run.cardUpdateFailed === 0 &&
    run.completeFromLedger === 1
  );
}
```

runId 匹配在调用方 `sse-watcher.processEntry` 做：解析 revision 的 `runId`，按 runId 找 `run_stream` 记录，再判 `canSkipFinalLedgerText`。

`completeFromLedger` 只在账本文本成功发出一次之后才置 1。首次投递时该标志为 0，跳不掉——terminal revision 到达时至少会发一次最终文本。跳过逻辑主要压制重连时的重放。

## 内容渲染

`render.ts` 从 `ConversationMessageRevision` 取 `text` 或 `blocks`——只抽 `type==="text"` 块（支持裸字符串、`{text}`、`{blocks}`、`ContentBlock[]`）。没有文本块（纯 tool_use/tool_result）时返回字面量 `"[Unsupported content]"`。工具活动在飞书里完全不可见。

## 失败模式

- 最终答案重复：terminal revision 重放 / `canSkipFinalLedgerText` 没命中。
- 不支持的内容：纯工具块 projected into ledger。
- 会话绑定错：飞书 chat 映射到了错误对话。
- 缺成员：飞书用户没解析成 human 成员。

## 关联页面

- [端总览](./overview.md)
- [对话账本](../conversation/history.md)
- [会话投影](../runs/output-and-live-updates.md)
- [飞书消息端到端](../flows/e2e-lark-message.md)
- [排障手册](../operations/troubleshooting.md)
