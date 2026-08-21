---
id: backend.loop-runner
title: LoopRunner — loopStep() 编排函数
status: current
owners: backend-runtime
last_verified_against_code: 2026-08-21
summary: "loopStep() 是 Loop 的执行入口——每次 cron 触发、HTTP run 或人 review 时调用一次。per-loop 写锁（withLoopLock）串行化所有入口；load DB -> 判断当前 step -> 对每个 fixing item 渲染 workflow 脚本并 enqueueAndAcquire -> 从 outcome.workflow.value 硬化解析 verdict -> loopReducer -> save DB。不是连续异步生成器——human gate 依赖 DB 跨进程持久，不依赖内存。"
depends_on:
  - foundations.loop
  - foundations.cron-job
  - agent.oma
used_by:
  - flows.e2e-loop-verification
---

# LoopRunner

> 执行模型为 **workflow-first**（[ADR 0025](../../adr/0025-loop-workflow-first-execution.md)，2026-08-20）：无 Generator/Evaluator 外层角色。实现见 `apps/backend/src/features/loop/loop-step.ts`。

`loopStep()` 被 CronJob 或手动 trigger 调用。它不保持内存状态——每次调用在 per-loop 写锁内 load DB 状态，判断下一步是什么，跑那一步，save 回 DB。

## loopStep() 签名

```typescript
function loopStep(params: {
  loopConfigPath: string;               // LOOP.md 所在目录
  loopId: string;
  store: LoopStateStore;                // DB 读写（loop_item/loop_budget）
  action?: {                            // human review 时提供
    itemId: string;
    verdict: "approve" | "reject" | "promote" | "retry" | "dismiss";
    feedback?: string;
  };
  withLoopLock: (loopId: string, fn: () => Promise<T>) => Promise<T>;
  withWorkspaceLock: (worktree: string, fn: () => Promise<T>) => Promise<T>;
  projectPort?: ProjectPort;
  dataDir?: string;
  convPort: ConversationPort;           // Loop conversation/audit 落点
  agentRunService: AgentRunService;
  agentRunExecution: AgentRunExecutionService;
  resolveModel: (ref: BackendModelRef) => Promise<ChatModel>;
  gitRunner?: GitRunner;                // 测试注入
}): Promise<LoopState>
```

## 每次调用做的事

```
1. withLoopLock(loopId) —— 串行化 cron/manual/review 三入口
2. store.load(loopId) —— 从 DB 读 state + inbox

3. 如果是 human review action:
   approve/reject/promote → loopReducer(APPROVE|REJECT_HUMAN|PROMOTE)
   retry                  → inbox item 重新 ADD_ITEM + TICK，从 inbox 删除
   dismiss                → 只从 inbox 删除
   → store.save → 返回

4. 如果是 cron TICK:
   a. resolveLoopWorktree（project worktree mirror）+ withWorkspaceLock 下 loopCleanStart
      —— per-step clean start；worktree diverged → 所有 fixing item ESCALATE 后返回
   b. 空 loop（无 item）且 dataDir 可用 → discoverItems()（auto-triage，best-effort）
   c. loopReducer(state, { type: "TICK" })  —— triaged → fixing
   d. 对每个 fixing item（受预算闸门限制）:
      - git revParse 取 baseSha
      - renderLoopWorkflow(item, cfg) → workflowScript
      - enqueueAndAcquire({
          backendKind: "oma", workflow: { script, args: { item } },
          idempotencyKey: `loop-gen:${loopId}:${itemId}:${baseSha}`,
          workflowBudgetTokens: dailyCap - spent,   // 冻结子进程预算
          workspace: { root: repoCwd, access: "read_write" },
        })
      - replay 短路：上次同 (item, baseSha) terminal 且非 completed → 发 fresh run
      - run 完成后 outcome.workflow.value → verdictFromWorkflow(value, changed, files)
        → loopReducer(state, { type: "EVALUATOR_VERDICT", itemId, verdict })
      - 预算闸门：spent >= dailyCap → notifyBudgetExceeded + break
   e. store.save(loopId, state, inboxItems) —— 原子落 DB
```

## workflow 执行与 verdict 硬化

- 脚本 = `renderLoopWorkflow(item, cfg)`：`fix` 子 agent（goal/action/taskClass 渲染）→ `verify` 子 agent（acceptance/verifyCommands 渲染，structured output schema 强制 JSON）。
- `outcome.workflow.value` 期望 `{ verdict, evidence, reasons, fixText }`。
- `verdictFromWorkflow()`（loop-step.ts:526）：`PASS` / `REJECT` / `ESCALATE` 直接采用；**无可用 verdict = 验收未执行 = 一律 REJECT**（有变化时附 changed files 证据，rollback 而非静默 PASS）。
- verify 子 agent 非法 JSON 自动重试一次；verifyCommands 强制逐条执行并贴完整输出，无输出 = REJECT。

## 为什么不是连续异步生成器

human gate 可能等几小时——进程重启、内存丢失。状态必须在 DB。每个 trigger 独立调用 `loopStep()`，不依赖上次调用的内存。

CronJob fires → `loopStep()` → 推进到 `awaiting_review` → 返回。几小时后，人 approve → `loopStep({ action })` → 推进到 `resolved` → 返回。

## 恢复与预防

- **Loop Doctor**（`loop-doctor.ts`）：zombie run → `abortStaleRun` 释放 branch；stale item → ESCALATE inbox；deferred_due → UNDEFER。启动补扫 + 每 5 分钟 + `POST /doctor`。
- **预防**：cron 超时 → abort → branch 立即释放；`withTimeout` 兜底卡死；`runTimeoutMs` watchdog。
- 失败不静默：triage 失败记日志不 kill tick；budget 超限写 Ledger `budget_exceeded` 消息；worktree diverged ESCALATE 交人工。

## 不变量

1. `loopStep()` 是无状态函数——状态全在 DB（loop_item/loop_budget）。
2. Workflow 是唯一执行单元——无外层 generator/evaluator 角色。
3. Human gate 依赖 DB 持久化，不依赖进程内存。
4. Verdict 内容驱动 step 转移；无验收输出一律 REJECT。
5. 所有入口过 per-loop 写锁——load → reducer → save 不交错。

## 关联页面

- [Loop](../foundations/loop.md) — 本页编排的实体（状态机/契约）
- [CronJob](../foundations/cron-job.md) — 调用 loopStep 的调度者
- [Loop 验证端到端](../flows/e2e-loop-verification.md) — 一次 tick 的时序
- [ADR 0025](../../adr/0025-loop-workflow-first-execution.md) — workflow-first 决策
