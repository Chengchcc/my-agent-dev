# Agent Runtime 重构路线图

> **For agentic workers:** 本文是总路线图，不是单个执行 handoff。执行时必须使用对应 workstream plan 和 task handoff。
>
> **Contract:** [`2026-07-23-agent-runtime-contract.md`](../specs/2026-07-23-agent-runtime-contract.md)
>
> **ADR:** [`0016-agent-runtime.md`](../../adr/0016-agent-runtime.md)

**Goal:** 在不破坏 Agent 生命周期、Session 持久化、Interrupt/Resume、Conversation projection、Cron 和 Loop 行为的前提下，将 `framework + harness` 收敛为 `@chengchenccc/agent`，并把 backend 功能装配统一为 Plugin + createAgentSession()。

**Architecture:** 采用 Strangler migration。先建立 `packages/agent` 生命周期边界，内部暂时复用 `framework`；再迁移 backend caller；再统一 backend caller 到 Plugin + createAgentSession；最后拆分 composition、清理命名并删除旧包。Capability/AgentExtension 试验代码已在 P8 删除。

**Tech Stack:** Bun 1.3.14、TypeScript NodeNext、Turborepo、bun:test、Elysia backend、Drizzle/SQLite、现有 `@chengchenccc/core` / `@chengchenccc/framework` / `@chengchenccc/harness`。

---

## 1. 文档分工

| 文档 | 职责 |
|---|---|
| `docs/adr/0016-agent-runtime.md` | 为什么重构、最终架构决策、长期不做项 |
| `docs/superpowers/specs/2026-07-23-agent-runtime-contract.md` | 跨 phase 公共接口、不变量、边界；执行 agent 不得自行修改 |
| 本文 | 全局依赖 DAG、workstream 顺序、phase gate、风险和回滚 |
| `2026-07-23-agent-runtime-foundation.md` | `packages/agent` 生命周期基础设施 |
| `2026-07-23-agent-runtime-backend-adoption.md` | Conversation/Resume/Cron/Loop/Skill Pack caller 迁移 |
| `2026-07-23-agent-runtime-capabilities.md` | Plugin-first production migration；已删除的 Capability 试验代码（P8 完整记录） |
| `2026-07-23-agent-runtime-cleanup.md` | conversation composition、backend bootstrap、命名清理、删除旧包 |

单个 agent 的 handoff 是临时执行包，不作为主路线图的替代品。每个 handoff 必须只针对一个 task。

## 2. 目标依赖图

```text
P0 Baseline
  ↓
P1 Agent package skeleton
  ↓
P2 Agent lifecycle
  ↓
P3 SessionManager / persistence
  ↓
P4 Framework adapter + AgentHooks
  ↓
P4R Agent runtime completion / framework absorption
  ↓
┌────────────────────────────────────────────┐
│ Backend caller adoption                     │
│ conversation / resume / cron / loop / skill │
└────────────────────────────────────────────┘
  ↓
P6-A Agent SDK core: Plugin assembly + ModelRuntime
  ↓
P6-C SDK integration gate
  ↓
P7 Plugin-first production migration
  ↓
P8 Remove Capability/AgentExtension + backend assembly cleanup
  ↓
P9 Backend bootstrap cleanup
  ↓
P10 One-at-a-time naming migration
  ↓
P11 Remove framework/harness and final verification
```

## 3. Workstream 顺序

### Workstream A：Runtime Foundation

文件：`2026-07-23-agent-runtime-foundation.md`

完成后必须得到：

```text
@chengchenccc/agent 可独立 build
Agent 行为覆盖 AgentSession 基线
SessionManager 可恢复已有 session
AgentHooks 有独立行为测试
P4R Agent runtime completion 已完成
backend 尚未迁移，但原有 backend 继续可 build
```

### Workstream B：Backend Adoption

文件：`2026-07-23-agent-runtime-backend-adoption.md`

完成后必须得到：

```text
backend 不再依赖 @chengchenccc/harness
Conversation、Resume、Cron、Loop、Skill Pack 都使用 @chengchenccc/agent
数据库 schema、AgentEvent payload、用户路径不变
```

五个 caller task 可以在 P4R Agent runtime completion 完成后并行，但每个 task 必须有独立文件 owner，不能同时修改 shared `package.json` / `bun.lock`。

### Workstream C：Plugin-first production migration

文件：`2026-07-23-agent-runtime-capabilities.md`

前置条件：Foundation、P4R Agent runtime completion、Backend Adoption、P6-A/P6-B/P6-C 全部通过。Plugin-first：所有功能通过 createAgentSession({ plugins }) 接入。

完成后必须得到：

```text
Conversation/Cron/Loop/Skill Pack 使用 createAgentSession({ plugins })
Plugin 行为保持兼容
backend 不重复实现通用 composer
```

### Workstream D：Cleanup

文件：`2026-07-23-agent-runtime-cleanup.md`


完成后必须得到：

```text
conversation-compose 按职责拆分
main.ts 只负责 bootstrap
旧命名逐项清理
framework/harness 无业务引用并可删除
```

## 4. Phase gate 总表

| P0 | 当前工作树 | baseline build/typecheck/test 已记录；已有失败清单明确 |
| P1 | 无新包 | `packages/agent` 独立 build/typecheck/test；无 backend/React 依赖 |
| P2 | P1 | Agent 行为测试覆盖 prompt/retry/compact/interrupt/steer/follow-up/dispose；不得吞掉目标行为失败 |
| P3 | P2 | SessionManager persistence recovery 测试通过；caller 不创建技术存储 |
| P4 | P3 | framework adapter 和 AgentHooks tests pass；backend 不需要 framework 才能创建 Agent |
| P4R | P4 | Agent runtime completion：`AgentEvent` typed；resume 真正消费 command；compact 真实持久化；usage 非固定 0；RunState per-run 透传；before:run/after:turn 完整；无 migration suppression；生产 SessionManager 边界明确 |
| P5A-E | P4R | 对应 caller scoped tests/typecheck/build pass；行为不变；不得从 harness/framework 混合导入同一配置边界 |
| P6-A | P5A-E | `packages/agent` Plugin/tool/model assembly tests pass；backend 不重复 composer |
| P6-C | P6-A | `createAgentSession()` integration test pass；ModelRuntime、Plugin、SessionManager、Agent 链路通过 |
| P7 | P6-C | Conversation/Cron/Loop/Skill Pack 使用 `createAgentSession({ plugins })`；Plugin 行为和 backend flows 不变 |
| P8 | P7 | Capability/AgentExtension deleted；backend Agent assembly 重复逻辑收敛；conversation projection 与 Agent factory 分离 |
| P9 | P8 | main/bootstrap smoke test passes；main no longer owns feature assembly |
| P10 | P9 | each old name is cleaned independently；scoped gate passes |
| P11 | P10 | framework/harness have no business references；full CI and smoke tests pass |

## 5. 统一执行规则

### 5.1 一个 task 一个 owner

以下目录不得被并行 agent 同时修改：

```text
packages/agent/src/**
apps/backend/src/main.ts
apps/backend/src/app.ts
apps/backend/package.json
bun.lock
```

每个 task 必须声明 allowed/forbidden files。发现需要修改 forbidden file 时停止并报告，不自行扩大 scope。

### 5.2 每个 task 的验证顺序

```text
scoped typecheck
→ scoped tests
→ affected package build
→ structural grep/check
→ review
→ downstream integration check
```

Bun test 不能替代 TypeScript typecheck。

### 5.3 不允许的 shortcut

- 不用 `any`、`@ts-ignore`、宽泛 `as` 压过新边界。
- 不把全量 rename 和行为迁移放在一个 task。
- 不同时迁移数据库 schema 和 runtime。
- 不把 Plugin 强制包装成 Capability。
- 不重新引入 Capability/AgentExtension 第二套 runtime。
- 不把 React slot component 类型带入 backend/runtime。

## 6. 回滚策略

### Foundation

旧 `framework` / `harness` 保留，backend 不迁移。回滚只删除新包或恢复 import。

### Backend Adoption

每个 caller 独立迁移。单个 caller 回滚到 `@chengchenccc/harness`，不触碰数据库。


### Cleanup

Cleanup 只能在旧引用清零后执行。删除旧包前保留可回滚提交点，并先通过全量 build/typecheck/test。

## 7. 风险优先级

### P0：阻断级

- sessionId 重新生成导致进程重启后 Agent 失忆。
- interrupt 被提前 dispose 或重复 consume。
- message revision 被重复投影。
- 新旧 Agent 同时写同一 session。
- Hook synthetic tool result 丢失，审批/guard 失效。

### P1：高风险

- `framework.Agent` 与 `agent.Agent` 同名导致边界混乱。
- Plugin 不直接依赖 backend Services 或写 ledger。
- conversation context 从 per-run 变成 per-session。
- loop usage 在 dispose 后不可读。
- spanId/origin 关联丢失。

### P2：治理风险

- route/command 使用弱类型 Record。
- 动态 loader 过早引入。
- shared package.json/bun.lock 被并行 agent 冲突修改。
- 大范围 rename 导致 diff 不可审查。

## 8. 最终 Go/No-Go

### Go

```text
[ ] Contract 未被执行 agent 私自修改
[ ] 每个 task 有 allowed/forbidden files
[ ] 每个 phase 有 scoped gate
[ ] Agent 行为测试覆盖旧 AgentSession
[ ] session recovery 通过
[ ] Conversation/Resume/Cron/Loop/Skill Pack 分开迁移
[ ] 无数据库 schema 未审查变化
[ ] 旧包引用清零
[ ] full build/typecheck/lint/test 通过
[ ] Conversation、Interrupt/Resume、Cron、Loop、Skill Install smoke tests 通过
```

### No-Go

```text
[ ] 用类型断言绕过边界
[ ] 只跑新包测试，不跑受影响 caller
[ ] 一个 task 修改多个无关 feature
[ ] 一个 phase 同时改 API、DB schema、runtime semantics
[ ] Agent 扩大 forbidden file scope
[ ] 新旧 runtime 双写
[ ] 没有 review 就进入下一 phase
```

## 9. 分支策略

```text
分支: feat/agent-runtime
从 master 分出
所有 phase 在此分支完成
每个 phase 独立 commit
全量 CI 通过才进入下一 phase
全部完成且用户审查同意后 → merge to master
```

| 规则 | 说明 |
|------|------|
| 不合并到 master | 未全部完成的中间状态不污染 master |
| 每个 phase 独立 commit | review 可按 phase 逐 commit 审查 |
| phase 间可 `git rebase -i` | 保持历史干净 |
| 禁止 force push 到 master | 只在本分支做 rebase |
| CI gate 每 phase | `bun typecheck && bun test && bun lint` 全量通过 |
