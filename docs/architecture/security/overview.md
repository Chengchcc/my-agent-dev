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

## 对话层：账本可见性

对话可见性的基本单位是 **Conversation**。所有成员共用一个 `conversation_ledger`；消息带 `senderMemberId` 与 `addressedTo`，端按成员身份渲染自己可见的部分。账本是共享事实，成员之间不会串台——没有 per-member session 投影。

## 执行层：工作区沙箱

`bash` / `glob` / `grep` 这类能触碰文件系统的工具，在 Oma 装配时被包进 Run 的 workspace root（`WorkspaceBinding { root, access: read_only | read_write }`，由 Product Backend 在 Run 快照中冻结）。Oma 子进程执行命令的可见范围被钉在沙箱内，碰不到沙箱之外的真实文件系统；Loop Run 使用 clone 出的独立 repo 作为 workspace root。

## 边界各管各的

把这几条边界放一起看，关键是它们**正交**：

- 鉴权管「谁能进后端」，不管「进来后能看哪条线程」；
- 线程隔离管「对话可见性」，不管「文件能不能跨域读」；
- 域隔离管「文件访问范围」，不管「shell 能跑到哪」；
- 工作区沙箱管「命令执行范围」。

任何一条数据流都同时受多条边界约束，单点被绕过不等于全局失守。

## 关联页面

- [Agent 工作区与多后端](../agents/workspace-and-backends.md)
