# ADR 0006: Loop 粒度写锁、原子预算、并发池 — MVP 不做

> ⚠ **状态更新(2026-08-13)**:本文末的"三项约束完整落地"已再次失效——后续 loop 重建(loop-service/loop-step 现结构)中写锁与并发池被移除,仅预算保留(LOOP.md `budget.dailyCap`)。当前无写锁;并发入口已收敛为单,决策回到 deferred 事实态。

## 状态

Deferred(曾落地后回退)

## 上下文

PRD 对这三个设计约束要求"P0 必做"：

1. **Loop 粒度写锁**：串行化 cron/manual/review 三入口对 STATE.md 的写入
2. **原子预算计数**：per-loop token 计数走带锁/CAS，不落 STATE.md
3. **AgentSession 并发池**：`maxParallelFindings` + 进程级池，防多-finding Loop 打满进程

M4 是 MVP 最后一棒：cron 触发 loopStep()、fireLoop() 自管 retry/timeout。上述三件事的触发条件在 M4 都还不成立：

- **写锁**：M4 只有 cron 一条入口（手动触发/POST review 在 M5）。`inFlight` 锁已保证 cron 不重叠。
- **预算计数**：M4 用硬编码 model name，没有真实 LLM 调用——token 消耗为 0。预算需要在真实 model 接线后（M5 LOOP.md 落地）才有意义。
- **并发池**：`loopStep()` 只处理一个 fixing item（串行）。M4 不引入并发。

## 决策

**三项全部移出 MVP。** M5 统一评估落地时机。

## 后果

- M4 不新增锁、计数器、池
- LOOP.md + 真实 model 接线后（M5），预算计数随预算保护一同落地
- 手动触发/review API 落地后（M5），写锁随三条入口一同落地
- 并发池在 loopStep() 支持多 item 后评估必要性

## 关联

- [ADR 0001](../adr/0001-loop-prune-is-post-processing.md)
- [CronJob 单飞锁](../architecture/foundations/cron-job.md)

## 修订 (2026-07-02)

M5（`/run`、`/review` HTTP）与 M6（Web review）已落地三入口，`buildSpec` 已接真实 anthropic model。原三条豁免前提全部失效：

- **写锁**：per-loop 进程内内存锁（Map-based Promise chain）已落地，单进程假设成立。多实例部署需升级为文件/分布式锁。
- **预算计数**：进程内 Map 计数器 + 可选 `budget.json`，从 LOOP.md `budget.dailyCap` 读 cap。
- **并发池**：`maxParallelFindings` 在 LOOP.md frontmatter 中定义（缺省 1），Semaphore 有界并发已落地。

**原决策翻转：三项约束由 loop-hardening 完整落地。**
