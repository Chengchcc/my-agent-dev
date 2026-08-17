# @chengchenccc/conversation

对话领域模型的 canonical definition。定义 Member（参与者身份）、Conversation（对话聚合）、LedgerEntry（账本条目的 zod schema + 类型）、以及 resolveTriggerTargets（触发解析）。纯 Zod schema 加无状态辅助函数。

## 为什么它是一个独立包

`conversation` 的领域类型被三个独立 app 跨端共享：

| 消费者 | 用途 |
|--------|------|
| `apps/backend` | ledger 存储、conversation projection、broadcast |
| `apps/web` | 前端 reducer、SSE 解析、UI 渲染 |
| `apps/lark-bot` | SSE 监听、飞书消息投递 |

## 核心概念

**Member。** 基于 `kind` 的判别联合：`AgentMember`（`kind: "agent"`）和 `HumanMember`（`kind: "human"`）。注意 `Member` 是**会话参与者身份**，与 `packages/message` 的 `MessageAuthor`（消息作者角色：system/user/agent/tool）不同层。

**Conversation。** 对话聚合：`conversationId`、`members`、`triggerMode`（`"mention" | "all"`，默认 `"mention"`）、`createdAt`。

**LedgerEntry。** 账本条目的 zod schema，是对话消息的**唯一规范本体**：

```ts
{
  seq: number; conversationId: string; senderMemberId: string;
  addressedTo: string[];
  kind: "message" | "member.joined" | "member.left" | "todo" | "surface.control";
  content: string;   // JSON 字符串
  ts: number;
  runId?: string;    // 追溯消息到运行，assistant 消息写入时携带
}
```

**触发解析（resolveTriggerTargets）。** 把 `addressedTo` 解析成 `AgentMember[]`。

**断言辅助。** `assertMember`（抛 `MemberNotFoundError`）、`assertAgentMember`（抛 `NotAgentMemberError`）。

## 依赖

`conversation` 依赖 `zod` + `@chengchenccc/message`（re-export codec）。被 `apps/backend`、`apps/web`、`apps/lark-bot` 三个 app 跨端依赖。
