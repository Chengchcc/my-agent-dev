# ADR 0007: `span` as canonical backend term, `run` as user-facing term

> ⚠ **已过期(2026-08-13)**:span/attempt/control_plane_event/span_origin 表已在 Phase 6 删除(迁移 0020),`run` 成为唯一执行身份——canonical 术语问题随 span 退役而消失。见 ADR 0016/0017。

## 状态

Superseded(was Accepted)

## 上下文

代码库里 span 和 run 混用描述同一件事——一次 `session.prompt()` 调用。`SpanSupervisor` 管理 `RunSession`，`span-executor.ts` 导出 `executeAgentRun()`，`spanId` 存进 `run` 表。CONTEXT.md 已写明收敛方向（L16）：**Span = root span，run 是旧词。**

问题：
1. 全仓代码一致性问题——新开发者看到两套名字要自己推导它们等价
2. "run" 有歧义——可以指整个 session（"这个 agent 的一次完整运行"），也可以指单次执行
3. "span" 是分布式追踪标准术语，与 `spanId` 字段名、OpenTelemetry 对齐
4. 但 Web UI 用户不懂什么是 "span"——用户看到的是 "Run Now"、"Run History"

## 决策

**Backend 代码 + DB 表用 `span`。Web UI 文案保留 `run`。**

理由：
- "span" 精确——一次 `prompt()` 调用 = 一个 root span，与 `spanId` 字段名一致，不需要翻译
- "run" 保留在 UI 层——设计哲学 §3："暴露业务，隐藏机制"。Span 是实现机制，Run 是用户可见的领域概念
- 映射：1 user-facing run = 1 backend span

具体改名：

| 旧名 | 新名 | 位置 |
|------|------|------|
| `run` 表 | `span` 表 | `schema.ts` |
| `schema.run` | `schema.span` | supervisor, store, agent-svc-factory |
| `RunSession` | `SpanSession` | `supervisor.ts` |
| `RunDeps` | `SpanDeps` | `span-executor.ts` |
| `RunRequest` | `SpanRequest` | `span-executor.ts` |
| `executeAgentRun()` | `executeAgentSpan()` | `span-executor.ts` |
| `run_origin` 表 | `span_origin` 表 | `schema.ts` |
| `run.executor.ts` | 文件名保持不变（已是 `span-executor.ts`） | — |
| Web UI "Run Now" | 不改 | 用户语言 |

不改的：
- Web 端所有 "run" 文案（用户可见，非机制名）
- `session-factory.ts` 的 `enqueuePrompt` 等——不涉及 span/run
- Loop 系统的 `useRunLoop()` hook——触发 Loop 执行，非 Span 概念

DB 迁移：`RENAME TABLE run TO span`（SQLite 原子操作，零数据风险）。

## 后果

- 25 处后端代码引用需更新（schema.ts, store.ts, supervisor.ts, agent-svc-factory.ts, db.test.ts）
- 1 个新 drizzle migration + 4 个 snapshot 自动重生
- CONTEXT.md 技术债务表 "run/span 混用" 条目可标记为已解决
- Web 端不受影响——不 import drizzle schema，UI 文案保留 "run"

## 关联

- [CONTEXT.md](../../CONTEXT.md) — 领域语言表 L16、技术债务表 L115
- [设计哲学 §3](../../docs/architecture/design-philosophy.md) — 暴露业务，隐藏机制
- [设计哲学 §5](../../docs/architecture/design-philosophy.md) — 名字就是架构
