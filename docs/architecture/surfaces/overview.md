---
id: surfaces.overview
title: 端总览
status: current
owners: architecture
last_verified_against_code: 2026-06-25
summary: "端是面向用户的适配器，目前是 Web 和飞书。它们采集输入、渲染 conversation SSE 推送的消息、把外部身份映射成成员、处理 UX 层的去重。端不拥有任何持久事实。"
depends_on:
used_by:
  - surfaces.web
  - surfaces.lark
---

# 端总览

端是面向用户的适配器，目前是 Web 和飞书。它们采集输入、渲染 conversation ledger SSE 推送的消息、把外部身份映射成成员、处理 UX 层的去重。端不拥有任何持久事实——事实存在于 conversation ledger 与 Agent Context 中（执行由一次性 oma 子进程完成，端不可见）。

## 端拥有什么、不拥有什么

端拥有：输入采集、对话历史渲染、外部身份映射、UX 级去重与重试展示。

端不拥有：账本真相、执行事实流真相、Agent 触发语义。

## 通用模式

```mermaid
flowchart LR
  User --> Surface
  Surface -->|消息 API| Backend
  Backend -->|Conversation SSE (MessageRevision)| Surface
  Surface --> User
```

所有消息输出（人类回声、assistant streaming 产出、最终答案、todo）都经 conversation SSE 承载。

## Web 与飞书的差异

| 维度 | Web | 飞书 |
|---|---|---|
| 身份 | 应用用户/会话 | 飞书 user/chat |
| 实时产出 | messageId upsert（同 run 的 streaming/done revision 替换同一气泡） | sse-watcher 解析 revision state 驱动投递 |
| 最终产出 | 账本文本 | 账本文本（按 canSkipFinalLedgerText 去重） |
| 消耗的 SSE | conversation SSE | conversation SSE |
| 主要风险 | 乐观消息残留 | terminal revision 重复投递 |

## 关联页面

- [Web 端](./web.md)
- [飞书](./lark.md)
- [对话账本](../conversation/history.md)
