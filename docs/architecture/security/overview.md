---
id: security.overview
title: 隔离与安全模型
status: current
owners: architecture
last_verified_against_code: 2026-07-28
summary: "这个系统的安全性不是靠一道总闸，而是靠几条彼此正交的隔离边界叠加：后端入口的鉴权中间件、对话层的线程隔离、文件层的域隔离、以及执行层的工作区沙箱。理解它们各自挡住什么、各自不管什么，才能知道一条数据从入口到落盘一路被哪些边界约束。"
depends_on:
  - conversation.members
used_by:
---

# 隔离与安全模型

这个系统的安全性不是靠一道总闸，而是靠几条彼此正交的隔离边界叠加：后端入口的鉴权中间件、对话层的线程隔离、文件层的域隔离、以及执行层的工作区沙箱。理解它们各自挡住什么、各自不管什么，才能知道一条数据从入口到落盘一路被哪些边界约束。

## 入口鉴权

后端入口用鉴权中间件校验请求头里的 `x-auth-token`，比较采用常量时间比较以避免时序侧信道（apps/backend/src/infra/auth.ts）。这是「谁能调后端」这一层的闸门。

## 对话层：线程隔离

对话可见性的基本单位是**会话**，约定 `sessionId = conversationId:memberId`。同一个共享对话里，每个成员有自己的一条消息投影记录（直接从 conversation_ledger 按 senderMemberId 读取）。这条约定决定了「账本是共享的事实，但每个成员看到的投影是按自己的 session 切出来的」——成员之间不会串台。

在 Agent runtime 内部，未显式指定时线程标识可退化为随机 UUID，保证每次运行至少有一个隔离的线程身份。

## 文件层：域隔离

AgentFS 用「域」把文件访问切成互不越界的几块（packages/agent-fs/src/agent-fs.ts）：

| 域 | 边界含义 |
|------|----------|
| `shared` | 跨运行/成员共享（如 `/memory`） |
| `private` | Agent 私有（如 `/skills` → `/private/skills`） |
| `external` | 外部资源 |

每次文件访问先按路径前缀匹配挂载项，再落到对应域的后端。Agent 看到的是友好路径，真实存储被域和挂载表挡在后面——它没法用一个 `/memory` 的句柄去读另一个域的数据。

## 执行层：工作区沙箱

`bash` / `glob` / `grep` 这类能触碰文件系统的工具，在 Agent 装配时被包进工作区根目录（workspace root）。这意味着 Agent 执行命令的可见范围被钉在沙箱内，碰不到沙箱之外的真实文件系统。

## 边界各管各的

把这几条边界放一起看，关键是它们**正交**：

- 鉴权管「谁能进后端」，不管「进来后能看哪条线程」；
- 线程隔离管「对话可见性」，不管「文件能不能跨域读」；
- 域隔离管「文件访问范围」，不管「shell 能跑到哪」；
- 工作区沙箱管「命令执行范围」。

任何一条数据流都同时受多条边界约束，单点被绕过不等于全局失守。

## 关联页面

- [对话与成员](../conversation/conversation-and-members.md)
- [Agent 默认装配](../harness/harness.md)
