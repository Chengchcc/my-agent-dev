# ADR 0003: STATE.md 只有 loopStep() 一个写者

## 状态

Accepted

## 上下文

Loop 运行时有三类 AgentSession：Discovery（发现 item）、Generator（改代码）、Evaluator（验证修复）。每个都在运行时产出数据：发现的 item、改动的文件列表、验证结论。

三种 AgentSession 是否可以各自写 STATE.md？

## 决策

**不。只有 loopStep() 写 STATE.md。所有 AgentSession 只汇报结果，loopStep() 解析汇报后经 reducer 更新 state 再写回文件。**

原因：
1. **避免并发写**：同一 Loop 可能同时有多个 AgentSession 在跑（多个 fixing item 并行），多写者需要锁，复杂度高
2. **单一数据完整性控制**：loopStep() 在写回前可以做去重（spinoff item 是否已存在）、格式校验（verdict 字段是否合法）
3. **跟 CronJob 单飞锁对齐**：三条入口（cron/manual/review）共用写锁的前提是只有 loopStep() 一个写者

Discovery 发现的 item：loopStep() 解析 findings → 调 `reducer(state, ADD_ITEM, ...)` → 写入
Generator 的产出：loopStep() 记录 → 调 `reducer(state, GENERATOR_DONE, ...)` → 写入
Evaluator 的 verdict：loopStep() 解析 → 调 `reducer(state, EVALUATOR_VERDICT, ...)` → 写入
Evaluator 的 spinoff 建议：loopStep() 决定是否采纳 → 调 `reducer(state, ADD_ITEM, ...)` → 写入

## 后果

- AgentSession 不能持有 STATE.md 的文件句柄
- AgentSession 的产出需要结构化到可被 loopStep() 解析的程度（verdict 格式、findings 格式）
- 为 spinoff 预留 verdict 扩展字段（`spinOffs?: { summary, source }[]`）

## 关联

- [LoopRunner](../architecture/backend/loop-runner.md)
- [Loop 验证端到端](../architecture/flows/e2e-loop-verification.md)
