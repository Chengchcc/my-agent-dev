# Compaction

Compaction 是长对话保持上下文可用性的核心机制。当对话 token 数超出预算时，将旧消息压缩为一段结构性摘要，替换到 LLM 上下文中。

## 关键实现文件

- `packages/agent/src/context/summarizing.ts` - 摘要生成 + 自动压缩 ContextPipeline
- `packages/agent/src/context/compaction/shake.ts` - 机械缩减大工具结果（无 LLM 调用）
- `packages/agent/src/context/compaction/cut-point.ts` - Token 感知的合法切点查找
- `packages/agent/src/context/compaction/prompts.ts` - 摘要 prompt 模板（8 段 markdown）
- `packages/agent/src/persistence/session.ts` - `CompactionEntry` 持久化 + `buildContext()` 重建

> Compaction 是 Oma 子进程内部的 Run-local 机制（`packages/agent`），随子进程销毁。Product Backend 不做 compaction；产品侧对应概念是 Agent Context 的 Product Summary。

## Session 条目模型

Compaction 是 Session Tree 的一等条目，不是普通消息：

```typescript
// SessionTreeEntry 联合类型
type SessionTreeEntry = MessageEntry | CompactionEntry | ModelChangeEntry;

interface CompactionEntry {
  type: "compaction";
  summary: string;       // LLM 生成的摘要文本
  firstKeptEntryId: string;  // 压缩边界
  tokensBefore: number;  // 压缩前 token 数
}
```

**上下文重建**（`Session.buildContext()`）：

1. 从根沿 parentId 链走到叶节点
2. 找最新 `CompactionEntry`
3. 将 `summary` 注入为一条 `role: "system"` 消息
4. 保留 `firstKeptEntryId` 之后的消息条目
5. 之后的条目原样追加

## 压缩管线

### 触发

唯一触发方式：`autoSummarize` ContextPipeline 在每轮 `shape()` 时检测 token 数是否超出 `triggerAt`。

```
shape(ctx, messages)
  → countTokens(messages) > triggerAt?
    → Step 1: shake 机械缩减
    → shake 后仍超? → Step 2: LLM 摘要
```

### 两阶段压缩

```
原始消息
    ↓
Step 1: shakeMessages()
    机械缩减大 tool_result，无 LLM 调用
    保护最近 16K token 的工具结果
    ↓
shaken 消息
    ↓ (如果仍超 triggerAt)
Step 2: 切点 + LLM 摘要
    findCutPoint(shaken, keepRecentTokens) → old + recent
    ↓
    structuredSummarize(old, model) → 摘要
    或 updateSummarize(old, prevSummary, model) → 迭代更新摘要
    ↓
    [summary, ...recent] → 返回给 LLM
```

### 切点算法（`findCutPoint`）

```
从尾部反向遍历消息：
  累加每条的估算 token 数
  超过 keepRecentTokens →
    向前找第一个 user 或 assistant 消息作为切点
    找不到 → 向后找最近的 user/assistant → 在此之后切
    全找不到 → 保留全部（返回 0）
不超预算 → 返回 0（保留全部）
```

**切点规则：**
- 只在 `user` 或 `assistant` 消息处切
- 绝不切在 `tool_result` 中间（防止 tool_use/tool_result 配对断裂）
- 绝不绝不绝在压缩后还需要 `repairToolPairs` 修复

### 摘要 prompt

抄自 OMP 的 `compaction-summary.md` 和 `compaction-update-summary.md`，8 段英文 markdown：

```markdown
## Goal
## Constraints & Preferences
## Progress
### Done
### In Progress
### Blocked
## Key Decisions
## Next Steps
## Critical Context
## Additional Notes
```

**迭代更新**（`updateSummarize`）：
- 传入 `<previous-summary>` XML 标签包裹的已有摘要
- 规则：保留历史 Goal/Decisions、Done 只增不减、Next Steps 更新
- 优先级：自定义 `summarizer` > `previousSummary` 存在时用 `updateSummarize` > 默认用 `structuredSummarize`

### 可逆压缩

Session Tree 支持可逆压缩：
- 压缩不删除原始消息，只追加 `CompactionEntry`
- `buildContext()` 从树中重建消息，按最晚 CompactionEntry 的边界过滤
- 回退只需 `moveTo(compactionEntry之前的entryId)`，原始消息完整保留

## 生产装配

Oma Runtime 装配 compaction 为默认管线（`packages/agent`），按 token 预算触发；Provider context overflow 时自动压缩后最多 retry 一次。Product Backend 不参与装配。

## 不做

- **Snapcompact**（Rust 原生 bitmap 压缩）— 需要 vision-capable 模型 + native 依赖
- **Handoff**（独立会话文档生成）— 无场景
- **Branch summarization**（分支摘要）— 无 `/tree` 功能
- **Mid-turn compaction**（回合内压缩）— 当前只在每轮 shape 时触发
- **远程 compaction**（remote endpoint）— 无需求
- **文件操作追踪** — oma 专属，通用 agent 价值不大
