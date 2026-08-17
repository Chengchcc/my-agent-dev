---
id: foundations.loop
title: Loop
status: design
owners: architecture
last_verified_against_code: 2026-07-28
summary: "Loop 是统一的工作系统--所有工作（自动发现或手动添加）的入口。Loop 不需要新数据库表：配置在 .loop/ 目录的文件里，运行时 item 状态在 STATE.md 里。CronJob 通过 loop_config_path 调用 Loop。手动工作池是 trigger=manual 的 Loop 特例。/issues Kanban 被 Loop 吸收，/loops 成为和 /conversations 并列的唯一工作入口。"
depends_on:
  - foundations.issue
  - foundations.cron-job
  - agent.oma
used_by:
  - backend.loop-runner
---

# Loop
> ⚠ **部分过时(2026-08-13)**:本页为 design 态;Loop 现已实现(generator/evaluator 两段,ADR 0004 的 discovery 已移除,0006 的锁/池未落地,0011 后 Issue 退役)。实现见 `apps/backend/src/features/loop/` 与 `packages/loop/`。

> 本页 `status: design`：grilling 后锁定的设计，尚未进代码。Issue 和 Loop 的关系已收敛：Loop 是统一的工作系统，Issue/Kanban 被吸收为 Loop 的特例。

Loop 是**按意图生成的工作流水线**。用户说"每天早上检查 CI，修简单失败"，系统生成配置，然后 Loop 按调度自动发现工作、执行、验证、等人拍板。手动工作也一样——人往里加 item，同一套流水线。

## 这页解决什么问题

[Issue](./issue.md) 和 [CronJob](./cron-job.md) 是两个独立实体：Issue 管手动工作流，CronJob 管定时触发一次 Agent 运行。两者都不表达"按调度自动发现工作 + 多步流水线推进 + 跨轮状态持久"。

Loop 统一这两个概念：
- CronJob 是调度者（到点调用 Loop）
- Issue 的工作流被 Loop 的 step 状态机吸收
- 手动工作 = trigger=manual 的 Loop

## Loop 没有自己的数据库表

Loop 的配置在文件系统，运行时状态在 STATE.md。唯一 DB 改动：CronJob 表加 `loop_config_path TEXT`。

```
.loop/
  config.yml       — generator/evaluator model + prompt + safety
  constraints.md   — denylist, budget cap, auto-merge policy
  skills/          — discovery SKILL.md
  STATE.md         — 运行时状态（首次运行时创建）
```

STATE.md 格式：
```markdown
# Loop State — Morning Triage
Last run: 2026-07-01T08:05:00Z

## Items
| id | source | summary | step | attempt | result |
|----|--------|---------|------|---------|--------|
| f-1 | ci/4821| auth flaky | awaiting_review | 1 | PASS |
| f-2 | issue/92| null deref | fixing | 2 | REJECT: scope drift |
```

一个文件，三个消费者：discovery agent 写、LoopRunner 读、人在 review queue 看。

## Item step 状态机

```
triaged → fixing → verifying → awaiting_review
                            ┌──────┼──────┐
                         resolved  inbox  promoted
```

- `triaged`：discovery 产出或人手添加，等待处理
- `fixing`：generator Agent 在修
- `verifying`：evaluator Agent 在审
- `awaiting_review`：等人拍板。状态在 STATE.md 里，跨进程重启不丢
- `resolved`：人通过了
- `inbox`：人不确定或 evaluator 反复失败，挂起
- `promoted`：人决定进更深的工作流（创建另一个 Loop 的 item）

evaluator 拒绝且 attempt < maxRetries → 回 `fixing`（带拒绝理由）。attempt 耗尽 → `inbox`。

## Generator 和 Evaluator 是分离的 Agent

不同 model、不同 system prompt、不同的 Agent Run（各自 spawn 独立 oma 子进程，run idempotency key 区分）。Evaluator 默认立场："ASSUME broken until proven otherwise"。验证通过执行测试和操作页面（MCP），不只读代码。

结构化 verdict（PASS/REJECT + 证据）解析后写入 item 的 result 字段，在 review card 里展示。

## Loop 的创建：自然语言意图

用户不选 pattern，不填表单。输入"每天早上检查 CI 失败，自动修简单的"，系统翻译成 Loop 配置，用户预览确认。Goal 是创建对话框里的过渡态——Loop 创建后 Goal 消失。

## 与 CronJob 的关系

CronJob 调度 Loop——不是 Loop 持有 schedule。CronJob 的 `loop_config_path` 指向 `.loop/` 目录，cron 触发时调 `loopStep(loopConfigPath)`。手动 Loop 没有 CronJob——通过 API 直接调 `loopStep`。

## 不变量

1. Loop 没有自己的数据库表——配置在文件，状态在 STATE.md。
2. CronJob 是调度者，Loop 是被调度者——Loop 不持有 schedule 字段。
3. Generator 和 Evaluator 是不同 Agent，不同 model。
4. Item 状态在 STATE.md，跨进程重启不丢——human gate 不需要进程存活。
5. Loop 吸收 Issue/Kanban——手动工作 = trigger=manual 的 Loop。

## 关联页面

- [LoopRunner](../backend/loop-runner.md) — loopStep() 编排函数
- [CronJob](./cron-job.md) — Loop 的调度者
- [Issue](./issue.md) — 被 Loop 吸收的原有工作流实体
- [Agent](../harness/harness.md) - Loop 调用的 Agent 胶水
