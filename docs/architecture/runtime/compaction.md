# Compaction

Compaction 是长对话保持上下文可用性的核心机制：当对话 token 数超出预算时，将旧消息压缩为一段结构性摘要，替换到 LLM 上下文中。

## 关键实现文件

- `apps/oh-my-agent/src/core/runtime/compaction.ts` — `compactSession()`：切点计算、tool 配对调整、摘要写回
- `apps/oh-my-agent/src/core/runtime/prompts.ts` — 摘要 prompt 模板（8 段 markdown）
- `apps/oh-my-agent/src/core/persistence/session-tree.ts` — 条目类型（message / compaction / todo）
- `apps/oh-my-agent/src/core/persistence/session-store.ts` — 上下文重建（buildContext）

> Compaction 是 Oma 子进程内部的 Run-local 机制，随子进程销毁。Product Backend 不做 compaction；产品侧对应概念是 Agent Context 的 Product Summary。

## 触发与两阶段

agent-loop 在 token 预算超限时触发：

```
countTokens > budget.limit?
  → Step 1: 机械缩减大 tool_result（无 LLM 调用，保护最近尾部）
  → 仍超? → Step 2: 切点 + LLM 摘要
```

## 切点算法

从尾部反向累加 token，超出保留预算后：
- 只在 `user` 或 `assistant` 消息处切
- 绝不切在 tool_result 中间——若切点落在 assistant tool_use 与 tool_result 之间，回退到该 assistant 之前（`adjustCutForToolPairs`）
- 全找不到 → 保留全部

## 摘要写回

`compactSession` 产出 `CompactionResult { entryId, coveredIds }`：摘要作为 `CompactionEntry` 追加进 SessionStore（覆盖范围记录在案），**原始 entries 不删除**——上下文重建时按最晚 CompactionEntry 的边界过滤，因此可逆。

迭代更新：传入 `<previous-summary>` XML 标签包裹的已有摘要；保留历史 Goal/Decisions、Done 只增不减、Next Steps 更新。

## 生产装配

Oma Runtime 默认装配 compaction，按 Run 冻结的 token 预算触发；Provider context overflow 时自动压缩后最多 retry 一次。Product Backend 不参与装配。

## 不做

- **Snapcompact**（Rust 原生 bitmap 压缩）— 需要 vision-capable 模型 + native 依赖
- **Handoff**（独立会话文档生成）— 无场景
- **Branch summarization**（分支摘要）— 无 `/tree` 功能
- **Mid-turn compaction**（回合内压缩）— 当前只在每轮 shape 时触发
- **远程 compaction**（remote endpoint）— 无需求
- **文件操作追踪** — oma 专属，通用 agent 价值不大
