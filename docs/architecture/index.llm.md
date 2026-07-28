# LLM 入口索引

当一个 LLM 需要回答关于 `my-agent-team` 架构的问题时，先读这个文件，再按下面的「问题类型 → 该读哪几页」去取对应正文。每一页正文都基于真实代码撰写，frontmatter 里的 `summary` 与 `depends_on` / `used_by` 可用于快速判断相关性。

> 提示：大部分页面为 `status: current`（基于当前代码）。少量页面为 `status: design`（已锁定但尚未进代码）。阅读时注意 frontmatter 的 `status` 字段区分。

## 如果问的是整个系统怎么运转

1. `system-overview.md`
2. `foundations/facts-and-projections.md`
3. `foundations/lifecycle-overview.md`
4. `backend/conversation-projection.md`

## 如果问的是消息重复 / 消息丢失 / 端上历史不一致

1. `foundations/facts-and-projections.md`
2. `backend/conversation-projection.md`
3. `conversation/ledger.md`
4. `surfaces/web.md` 或 `surfaces/lark-adapter.md`
5. `operations/troubleshooting.md`

## 如果问的是运行生命周期 / 取消 / 恢复 / 卡住的运行

1. `backend/overview.md`
2. `runtime/framework.md`
3. `foundations/identifiers.md`
4. `foundations/lifecycle-overview.md`

## 如果问的是数据归属（谁是事实来源）

1. `foundations/facts-and-projections.md`
2. `backend/data-model.md`
3. `conversation/ledger.md`
4. `backend/event-log.md`（已废止，tombstone：执行事实流回归 checkpoint_events）

## 如果问的是飞书

1. `flows/e2e-lark-message.md`
2. `surfaces/lark-adapter.md`
3. `backend/conversation-projection.md`
4. `conversation/conversation-and-members.md`

## 如果问的是 Web

1. `flows/e2e-web-message.md`
2. `surfaces/web.md`
3. `conversation/ledger.md`
4. `backend/conversation-projection.md`

## 如果问的是 Agent 执行内核 / 插件 / 记忆 / 技能 / task-guard

1. `runtime/framework.md`
2. `runtime/plugin.md`
3. `runtime/context-manager.md`
4. `harness/harness.md`（Agent 的构造与生命周期）
5. `plugins/fs-memory.md`、`plugins/progressive-skill.md`、`plugins/task-guard.md`、`plugins/skill-pack.md`

## 如果问的是上下文窗口 / 历史压缩 / 摘要 / 裁剪

1. `runtime/context-manager.md`
2. `runtime/framework.md`
3. `harness/harness.md`（Agent 的构造与生命周期）

## 如果问的是安全 / 隔离

1. `security/overview.md`
2. `conversation/conversation-and-members.md`

## 如果问的是 Loop / 自动化编排 / Generator-Evaluator 分离

> `foundations/loop.md`、`backend/loop-runner.md`、`foundations/loop-pattern.md` 均为 `status: design`（已锁定设计，尚未进代码）。

1. `foundations/loop.md`
2. `backend/loop-runner.md`
3. `foundations/loop-pattern.md`

## 如果问的是未来方向

读 `roadmap/future-work.md`，并顺其关联链接。**不要把 roadmap 条目当成当前行为。**

## 结构化清单

完整的概念图谱（id / 标题 / 状态 / 依赖 / 被依赖 / 路径 / 摘要）见同目录 `concepts.json`，可直接被程序消费。
