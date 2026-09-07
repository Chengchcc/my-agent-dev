# ADR 0004: Discovery 是 loopStep() 内的独立 AgentSession

> ⚠ **已取代(2026-08-21)**：发现环节已回归，但形态不是独立 AgentSession：ADR 0025 的 workflow-first 把 discovery 实现为 **triage workflow**(`discoverItems()` 扫 repo mirror 信号 → triage 子 agent → 幂等 ADD_ITEM，见 `loop-step.ts`)。本文的"独立 Discovery AgentSession + loop-triage skill"设计保留为历史。

## 状态

Superseded by ADR 0025 (was Accepted, then wrongly marked Obsolete 2026-08-13 — discovery was never removed, only re-shaped)

## 上下文

原 loop-runner.md 的 loopStep() 伪代码直接对 fixing item 起 Generator，没有 discovery 阶段。但 loop-engineering.md 的五动作表明确列了 Discovery 是第一动作，状态为"新增"。

问题：Discovery 是 loopStep() 内的一步，还是 loopStep() 之外的前置步骤？

## 决策

**Discovery 是 loopStep() TICK 路径的第一步，以独立 AgentSession 形式执行。**

完整 TICK 流程：
1. 起 Discovery AgentSession（装 loop-triage skill）→ 产出 findings 列表
2. loopStep() 解析 findings，经 reducer ADD_ITEM 写入 state
3. reducer TICK 把 triaged → fixing
4. 对每个 fixing item 起 Generator → 起 Evaluator
5. 写回 STATE.md

Discovery AgentSession 与 Generator/Evaluator 同级，不同 sessionId、不同 model、不同 Skill。区别只在它**先跑、产出被写入 STATE.md 后才推进后续**。

## 后果

- loopStep() 内有三类 AgentSession：Discovery → Generator → Evaluator
- Discovery 的 findings 格式需结构化（至少包含 summary + source）
- 手动 Loop（trigger=manual）跳过 Discovery：没有 discovery skill，不扫外部信号
- loop-runner.md 伪代码需补上 Discovery 步骤

## 关联

- [LoopRunner](../architecture/backend/loop-runner.md)
- [Loop](../architecture/foundations/loop.md)
