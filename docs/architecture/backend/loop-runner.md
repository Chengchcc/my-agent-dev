---
id: backend.loop-runner
title: LoopRunner — loopStep() 编排函数
status: design
owners: backend-runtime
last_verified_against_code: 2026-07-28
summary: "loopStep() 是 Loop 的执行入口--一个无状态函数，每次 cron 触发或人 review 时调用一次。读 STATE.md -> 判断当前 step -> 起 generator/evaluator Agent -> 写回 STATE.md。不是连续异步生成器--human gate 依赖 STATE.md 跨进程持久，不依赖内存。"
depends_on:
  - foundations.loop
  - foundations.cron-job
  - agent.agent
used_by: []
---

# LoopRunner

> 本页 `status: design`：grilling + prototype 后锁定的设计。核心是 `loopStep()` —— 一个无状态的每次调用跑一步的函数，不是连续异步生成器。

`loopStep()` 被 CronJob 或 manual trigger 调用。它不保持内存状态——每次调用读 STATE.md，判断下一步是什么，跑那一步，写回 STATE.md。

## loopStep() 签名

```typescript
function loopStep(params: {
  loopConfigPath: string;               // .loop/ 目录路径
  action?: {                            // human review 时提供
    itemId: string;
    verdict: "approve" | "reject" | "promote";
    feedback?: string;
  };
}): Promise<StepResult>
```

## 每次调用做的事

```
1. 读取 .loop/config.yml + STATE.md + constraints.md

2. 如果是 human review action:
   → 调 loopReducer(state, { type: APPROVE|REJECT_HUMAN|PROMOTE, itemId, ... })
   → 写回 STATE.md
   → 返回

3. 如果是 cron TICK:
   a. 启动 Discovery Agent（装 loop-triage skill）-> 产出 findings
   b. 每个 finding 经 loopReducer(state, { type: ADD_ITEM, ... }) 写入
   c. loopReducer(state, { type: TICK })  — triaged → fixing
   d. 对每个 fixing item: 启动 generator Agent
      -> generator 完成 -> loopReducer(state, { type: GENERATOR_DONE, itemId })
      -> 启动 evaluator Agent
      → evaluator 产出 verdict → loopReducer(state, { type: EVALUATOR_VERDICT, itemId, verdict })
      → PASS → item.step = "awaiting_review"
      → REJECT → loopReducer 处理 retry/inbox
   e. filter 掉 step ∈ {resolved, inbox, promoted} 的已终结 item（不是 reducer action，是写回前过滤——见 [ADR 0001](../../adr/0001-loop-prune-is-post-processing.md)）
   f. 写回 STATE.md
   g. 返回
```

## 为什么不是连续异步生成器

human gate 可能等几小时——进程重启、内存丢失。状态必须在文件里。每个 trigger 独立调用 `loopStep()`，不依赖上次调用的内存。

CronJob fires → `loopStep()` → 推进到 `awaiting_review` → 返回。几小时后，人 approve → `loopStep({ action })` → 推进到 `resolved` → 返回。

## Generator 和 Evaluator 分离

同一个 item 的 generator 和 evaluator 是不同的 Agent Run（各自 spawn 独立 coding-agent 子进程）：

```
generator run:
  model:        config.generator.model
  idempotency:  "loop:<loopId>:gen:<itemId>:<attempt>"
  systemPrompt: config.generator.prompt

evaluator run:
  model:        config.evaluator.model     ← 必须 ≠ generator.model
  idempotency:  "loop:<loopId>:eval:<itemId>:<attempt>"
  systemPrompt: config.evaluator.prompt    ← 默认怀疑立场
```

Evaluator 产出结构化 verdict——`loopStep()` 解析 "PASS" 或 "REJECT: reasons..."，喂给 `loopReducer`。

## 安全注入

每次 generator/evaluator 启动前，从 `constraints.md` 注入：
- denylist 路径 → system prompt 头部
- budget cap → 启动前检查，超限跳过 item
- auto-merge 策略 → generator 不推 commit，除非 allowlist 命中

## 不变量

1. `loopStep()` 是无状态函数——状态全在 STATE.md。
2. Generator 和 Evaluator 是不同 Agent，不同 model。
3. Human gate 依赖 STATE.md 的文件持久，不依赖进程内存。
4. Evaluator 的 verdict 结构化解析后写入 item result 字段。

## 关联页面

- [Loop](../foundations/loop.md) — 本页编排的实体
- [CronJob](../foundations/cron-job.md) — 调用 loopStep 的调度者
- [Agent Backend](../execution/agent-backend.md) — generator/evaluator 的执行链
