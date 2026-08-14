---
id: conversation.members
title: 对话与成员
status: current
owners: architecture
last_verified_against_code: 2026-06-22
summary: "对话是共享协作空间，成员是人/Agent/系统在这个空间里的本地身份。触发模式、跳数上限、活动锁和 @提及解析，共同防止多 Agent 失控地互相触发。"
depends_on:
used_by:
  - flows.e2e-lark-message
  - runs.output-and-live-updates
---

# 对话与成员
> ⚠ **已过时(2026-08-13)**:ADR 0021 收编为一个对话一个 Agent(member 恰一,human 消息为外部事件);roster、@提及解析、wake routing 的多成员机制已退化/删除(relationships 已删,迁移 0026)。本页保留为历史,现行模型见 [Agent 工作区与多后端](../agents/workspace-and-backends.md)。

对话是共享协作空间，成员是人/Agent/系统在这个空间里的本地身份。触发模式、跳数上限、活动锁和 @提及解析，共同防止多 Agent 失控地互相触发。

## 成员类型

| kind | 含义 | 常见来源 |
|---|---|---|
| `human` | 人 | Web 用户或飞书用户 |
| `agent` | 可运行的 Agent | 后端 agent 注册表 |
| `__system__`（哨兵发送者） | 系统通知 | 后端服务 |

## 触发模式

- `mention`：多 Agent 对话的默认，必须显式 @ 到某 Agent 才触发它。
- `all`：单 Agent 对话适用，任何消息都触发。

`postMessage` 按触发模式 + `addressedTo` 经 `resolveTriggerTargets(conv, addressedTo)` 解析出目标 Agent 成员。

## 线程身份

某成员的 Agent 执行 thread 用 `deriveThreadId(conversationId, memberId)` = `` `${conversationId}:${memberId}` ``。它标识「共享对话里某个成员的视角」，是推导出来的、不持久化（threads 表是遗留）。

## 多 Agent 安全：四道闸

1. **触发模式** 决定是「全部触发」还是「仅被 @ 才触发」。
2. **活动锁**：[`ConversationLock`](../backend/data-model.md)（M17.5 替换了旧的 `activeConversations` Set + `pendingRuns` Map）。`lock.acquire(conversationId, targetCount)` 加锁；`lock.releaseOne(conversationId)` 每完成一个 run 递减；归零自动解锁。对话锁未释放时 `postMessage` 抛 `ConversationBusyError`，而 `triggerMentionedAgents` 则静默跳过。
3. **跳数（hop_count）**：人或 `__system__` 发送者把跳数重置为 0；已知 Agent 发送者 +1；上限 `maxConsecutiveAgentHops`（main.ts 设为 **8**）。超限不再 fork，改追加一条 `__system__` 消息说明触顶。
4. **@提及解析**：在 `main.ts` 的 `onRunMessage` 回调里做（终端修订时扫描，不在 service 里）。对每个 roster 成员，用 `` new RegExp(`@${escapeRegExp(label)}(?=\\s|[,.!?;:]|$)`, "g") `` 扫 assistant 文本，外加 `text.includes("@${memberId}")`。

## Agent 产出里的 @提及

@提及处理已经**不只是端的事**了：完成钩子会以只读方式扫描整段运行产出，命中就 `triggerMentionedAgents`。这意味着 Agent 之间可以互相 @ 触发，但每一跳都受上面四道闸约束。

## 失败模式

- Agent 没被触发：提及没解析上、触发模式拦住了、有活动锁、或到了跳数上限。
- Agent 被触发两次：完成处理重复或缺锁。
- 错的 Agent 看到消息：成员→thread projection mapping错了。

## 关联页面

- [对话账本](./history.md)
- [会话投影](../runs/output-and-live-updates.md)
- [飞书消息端到端](../flows/e2e-lark-message.md)
- [排障手册](../operations/troubleshooting.md)
