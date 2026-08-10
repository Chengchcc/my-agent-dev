# ADR: Compaction 质量提升

**日期**: 2026-07-22
**状态**: design
**范围**: `packages/framework/src/context-managers/summarizing.ts`, `packages/framework/src/compaction/`

---

## 背景

当前 `autoSummarize` 有两处短板：
1. `structuredSummarize` 用 5 段中文自由格式，不如 OMP 的 8 段 markdown + checkbox 结构
2. `autoSummarize` 的 cut point 是 `slice(0, -keepRecent)` 按消息数盲切，可能切断 tool_use/tool_result 对
3. 无迭代更新——每次压缩重新生成摘要，不认得已有的 previous summary

## 调研

对比了 Pi (`/root/pi/packages/coding-agent/src/core/compaction/`) 和 OMP (`/root/.bun/install/global/node_modules/@oh-my-pi/pi-agent-core/src/compaction/`)。

## 决策

### 1. 摘要 prompt → 抄 OMP 的 `compaction-summary.md`

OMP 的 8 段 markdown 格式：

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

比我们当前的 5 段中文（目标/约束/进度/关键决策/下一步）多了 Done/In Progress/Blocked 拆分、Critical Context、Additional Notes。这个格式和系统里已有的 `<system-reminder>` XML 风格不冲突——prompt 本身是给 LLM 看的，不是给 agent 看的。

### 2. 迭代更新 → 抄 OMP 的 `compaction-update-summary.md`

当已经存在一次 compaction 的 summary（Session Tree `CompactionEntry`）时，不再重新生成，而是传入 `<previous-summary>` + 新消息做增量合并。OMP 的版本有显式的 per-section 保留规则（保持历史 Goal、Done 只增不减、Next Steps 更新等），比 Pi 的版本更精确。

### 3. 切点 → 抄 Pi 的 `findCutPoint`

从尾部反向 walk 消息，按 `estimateTokens` 累加 token 数，当超出 `keepRecentTokens` 预算时停止。关键约束：**只停在 user/assistant 消息边界**，不切 tool_use/tool_result 中间。

我们已有 `repairToolPairs` 做事后修复，但预防比修复更干净。`sliding-window.ts` 的 `splitTurns` 可复用其 turn 边界识别逻辑。

### 不做

- OMP 的 `compaction-short-summary.md`（2-3 句 PR 描述）— recap 已覆盖
- Pi 的文件操作追踪 — coding-agent 专属
- Pi 的 turn prefix 分段摘要 — 边缘场景（单 turn 超大）
- OMP 的 snapcompact — Rust 原生 + vision 依赖

## 实现

1. `structuredSummarize` 替换为 OMP 的 8 段 prompt，英文，作为新的 `structuredSummarize` v2
2. 新增 `updateSummarize(old, previousSummary, model)` 迭代更新函数
3. `autoSummarize` 的 `old = shaken.slice(0, -keepRecent)` 替换为 `findCutPoint(messages, keepRecentTokens)`
4. `findCutPoint` 实现在 `packages/framework/src/compaction/cut-point.ts`
