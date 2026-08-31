---
id: agents.projects-and-worktrees
title: Project 与 Worktree
status: current
owners: architecture
summary: "Project 是仓库级协作实体（name/repoUrl/defaultBranch）；每个 Agent 对每个 Project 拥有一个 git worktree（features/project/worktree-ops），project 绑定的 conversation 的 Agent Run 以该 worktree 为 workspace 运行。per-worktree 锁（workspace-lock）把 run dispatch、clean-start/reset、agent detach 序列化在同一 root 上（ADR 0023）。"
depends_on:
  - agents.workspace-and-backends
used_by:
  - backend.overview
---

# Project 与 Worktree

## Project

`features/project` 提供 Project CRUD：`projectId / name / repoUrl / defaultBranch`。Project 是仓库级协作实体——多个 conversation 可以挂在同一 project 上（ADR 0023）。

## Worktree

每个 Agent 对每个 Project 物化一个 git worktree（`worktree-ops.ts`），使不同 Agent 在同一仓库上隔离工作：

- `WorktreeStatus` / `WorktreeOps`（`createWorktreeOps`）：clone、worktree add/remove、状态查询
- project 绑定的 conversation 的 Agent Run 以**该 Agent 在该 project 的 worktree** 为 workspace 运行（`execution.ts` 的 `resolveWorkspace`：conversation 有 projectId → agent 的 worktree；未 attach → 显式 dispatch 失败）
- 上下文（skills/prompt/token）仍来自 agent workspace；只有 cwd 指向 worktree

## Workspace 锁

`workspace-lock.ts`（`createWorkspaceLockRegistry`）：per-worktree 互斥（promise-chain tail per root，最后一个 waiter 结束时移除条目）。**run dispatch、clean-start/reset、agent detach 三者共享同一 root 的锁**，防止并发操作同一个 worktree。

## 不变量

1. Project 是仓库级实体；worktree 是 per-(agent, project) 物化产物
2. project-bound conversation 的 Run 在 worktree 里跑；未 attach 即失败（不静默回退）
3. 同一 worktree root 的操作经 workspace lock 串行化
4. Agent workspace（身份/技能/配置）与 worktree（代码）分离，不互相覆盖

## 关联页面

- [Agent 工作区与多后端](./workspace-and-backends.md)
- [Product Backend 总览](../backend/overview.md)
- [ADR 0023（worktree workspace）](../../adr/0023-project-worktree-workspace.md)
