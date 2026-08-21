---
id: foundations.loop
title: Loop
status: current
owners: architecture
last_verified_against_code: 2026-08-21
summary: "Loop 是统一的工作系统——自动发现（auto-triage）或手动添加的 item 经 workflow-first 流水线执行：每 item 渲染 fix+verify 子 agent 的 workflow 脚本，在子进程 vm sandbox 执行，返回 { verdict, evidence } 进状态机。状态持久化在 DB（loop_item/loop_budget 两表），STATE.md 仅剩一次性迁移读取（migrate-legacy.ts）。per-loop 写锁串行化 cron/manual/review；Loop Doctor 巡检 zombie run/stale item/deferred_due。taskClass 驱动差异化 fix 指导，defer 支持延期。"
depends_on:
  - foundations.cron-job
  - agent.oma
used_by:
  - backend.loop-runner
  - flows.e2e-loop-verification
---

# Loop

Loop 是**按意图生成的工作流水线**。用户说"每天早上检查 CI，修简单失败"，系统生成 LOOP.md 配置，CronJob 到点调 `loopStep()`，Loop 自动发现工作、执行、验证、等人拍板。手动工作也一样——人往里加 item，同一套流水线。

> 执行模型在 2026-08-20 由 [ADR 0025](../../adr/0025-loop-workflow-first-execution.md) 重写为 **workflow-first**：Generator/Evaluator 双 Agent 角色已删除。本文描述当前实现，代码见 `apps/backend/src/features/loop/` + `packages/loop/`。

## 执行模型：Workflow 是唯一执行单元

每个 item 的执行 = 一段 workflow 脚本，由 `renderLoopWorkflow(item, cfg)` 渲染，作为 `BackendRunInput.workflow` 直接交给子进程执行：

```text
loopStep(TICK)
  → 对每个 fixing item：renderLoopWorkflow(item, cfg)
  → enqueueAndAcquire({ workflow: { script, args: { item } }, ... })
  → oma 子进程 vm sandbox 执行脚本
      → fix 子 agent（按 goal/action/taskClass 渲染 prompt）
      → verify 子 agent（按 acceptance/verifyCommands 渲染 prompt，structured output 约束）
      → return { verdict: PASS|REJECT|ESCALATE, reasons, evidence }
  → verdictFromWorkflow(value) 硬化解析
  → loopReducer(state, { type: "EVALUATOR_VERDICT", ... })
```

要点：

- **没有外层 generator/evaluator Agent 角色**。fix/verify 是脚本内两个子 agent；外层模型只执行脚本 + 返回 verdict，不再有自己的 skill/systemPrompt（已删除 `loop-generator`/`loop-verifier`）。
- **verdict 硬化**：`verdictFromWorkflow()` 对无验收输出的变化一律 REJECT（带 fallback reason），绝不静默 PASS；`verifyCommands` 存在时 verify 子 agent 被强制逐条执行并把完整输出贴进 evidence，某命令无输出 = 未验证 = REJECT。
- **structured output**：verify 子 agent 的 schema 是 `{ verdict: enum[PASS,REJECT,ESCALATE], reasons: array, evidence: string }`，非法 JSON 自动重试一次（追加"只返回 JSON"提示）。
- **PASS 且 evidence 为空** → reducer 路由 inbox（既有 gate），人工兜底。
- 旧 LOOP.md 格式（generator/evaluator 双段）**不再解析**——`parseLoopConfig` 返回 null，既有 loop 需重写（ADR 0025 §2 显式不兼容）。

## 状态与持久化：DB 是唯一状态源

Loop 状态**在数据库**，不在文件：

| 表 | 内容 |
|---|---|
| `loop_item`（schema.ts:176） | item 状态机行（step/attempt/result/task_class/defer 列） |
| `loop_budget`（schema.ts:196） | per-loop 每日预算计数（原子读改） |

- `STATE.md` / `INBOX.md` 只被一次性迁移脚本 `migrate-legacy.ts` 读取（`bun run .../migrate-legacy.ts <loopsDir> <dbPath>` 把旧文件状态灌进 DB），**不再是运行时状态源**。
- 配置仍在文件：LOOP.md（契约见下）+ 工作区（project worktree mirror）。
- 跨进程重启不丢——human gate 依赖 DB 持久化，不依赖进程存活。

## Item step 状态机

```
triaged → fixing → verifying → awaiting_review
                            ┌──────┼──────┐
                         resolved  inbox  promoted
```

- `triaged`：auto-triage 产出或人手添加，等待处理
- `fixing`：item 的 workflow run 在跑（fix 子 agent 干活）
- `verifying`：workflow 内 verify 子 agent 在审（fix 完成后脚本自动进入）
- `awaiting_review`：等人拍板
- `resolved`：人通过了
- `inbox`：人不确定 / evaluator 反复失败 / verdict 缺失 / PASS 无 evidence——挂起
- `promoted`：人决定进更深的工作流

reducer 动作（`packages/loop/src/loop-reducer.ts`，11 case）：`TICK`、`ADD_ITEM`、`EVALUATOR_VERDICT`、`APPROVE`、`REJECT_HUMAN`、`PROMOTE`、`RETRY`、`DISMISS`、`DEFER`、`UNDEFER`（`GENERATOR_DONE` 保留兼容，当前执行路径不再发出）。REJECT 且 attempt < maxRetries → 回 `fixing`（带拒绝理由）；attempt 耗尽 → `inbox`。

### taskClass 与 defer（ADR 0025 §4）

- `ItemState.taskClass`：`bugfix | feature | refactor | research | review | chore`。`renderLoopWorkflow` 按类注入 `TASK_CLASS_GUIDANCE` 差异化 fix 指导（bugfix 先复现/最小改动/补回归；research/review 只读不改码等）。LOOP.md `workflow.fixPrompt` 覆盖全部。
- `ItemState.defer { reason, until?, after? }`：`DEFER`/`UNDEFER` action；TICK 跳过 defer 项，`until` 到期（`opts.now`）或 `after` 依赖 resolved 自动恢复。
- 持久化：`loop_item` 表 `task_class` / `defer` 列（迁移 0036）。

## 调度、锁与预算

- **CronJob 是调度者**：Loop = `cron_job(loopConfigPath)`；cron 到点 `fireLoop → loopStep(TICK)`。手动 loop 没有 CronJob，直接 HTTP 调 loopStep。
- **per-loop 写锁**：`loop-lock.ts`（Map-based Promise chain）串行化 cron/manual/review 三入口——`loopStep` 的 `withLoopLock(loopId, fn)` 保证 load → reducer → save 不交错（ADR 0006 已落地；8 个调用点含 cron scheduler + HTTP）。
- **工作区锁**：worktree 操作走 `withWorkspaceLock`，per-step clean start（`loopCleanStart`），live run 先 settle。
- **预算**：`loop_budget` 表每日计数，`budget.dailyCap` 超限熔断 + 通知（Ledger `budget_exceeded` 消息）；workflow run 冻结 `workflowBudgetTokens = dailyCap - spent`，子进程内子 agent spawn 受闸门约束。

## 发现（auto-triage）

`discoverItems()`（loop-step.ts:325）扫 repo mirror 信号（新提交 / agent 分支待合并产出 / 粘贴文本），跑 triage workflow（与 fix/verify 同构的 workflow 执行），产出结构化 `{ findings: [{ source, summary, taskClass, priority }] }`，按 summary hash 幂等 `ADD_ITEM`。触发：cron tick 遇到空 loop（loop-step.ts:671 自动跑，best-effort 失败不 kill tick）+ 手动 `POST /triage`。webhook 留 v2。

## 恢复（Loop Doctor）

`loop-doctor.ts` 巡检三类问题（启动补扫 + 每 5 分钟 + 手动 `POST /doctor`）：

| kind | 发现 | 动作 |
|---|---|---|
| `zombie_run` | active run 已死但 branch 未释放 | `abortStaleRun`（释放 branch） |
| `stale_item` | run 已 terminal 但 item 卡 fixing/verifying | `ESCALATE` → inbox |
| `deferred_due` | defer 的 until/after 条件已满足但无 tick 跑 | `UNDEFER` |

预防侧：cron 超时 → `AbortController.abort` → loopStep 停止 live run、branch 立即释放；`withTimeout` 兜底卡死；`runTimeoutMs` watchdog 最后防线。

## LOOP.md 契约（workflow-first）

```yaml
projectId: ...
agent: default
model: ...            # 单一 model，子 agent 共享（不再有 generator/evaluator 双段）
acceptance: ...       # 完成定义
safety:
  denylist: [...]
budget:
  dailyCap: ...
workflow:
  fixPrompt: ...       # 缺省由 goal/action/taskClass 渲染
  verifyPrompt: ...    # 缺省由 acceptance/verifyCommands 渲染
  verifyCommands: [...] # 结构化验收命令清单
```

## 不变量

1. Workflow 是唯一执行单元——无外层 generator/evaluator 角色（ADR 0025）。
2. 状态在 DB（loop_item/loop_budget），STATE.md 不是运行时状态源。
3. per-loop 写锁串行化 cron/manual/review 三入口。
4. verdict 内容驱动 step 转移，不靠 run 终态推断；无验收输出一律 REJECT。
5. CronJob 是调度者，Loop 是被调度者——Loop 不持有 schedule 字段。
6. Loop 吸收 Issue/Kanban——手动工作 = trigger=manual 的 Loop。
7. taskClass/defer/doctor/triage 是生产主路径，不是规划。

## 关联页面

- [LoopRunner](../backend/loop-runner.md) — loopStep() 编排函数
- [CronJob](./cron-job.md) — Loop 的调度者
- [Loop 验证端到端](../flows/e2e-loop-verification.md) — 一次 tick 的完整时序
- [ADR 0025](../../adr/0025-loop-workflow-first-execution.md) — workflow-first 决策正典
