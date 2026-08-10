# ADR: Autonomous Memory

**日期**: 2026-07-22
**状态**: design
**范围**: `packages/plugin-memory`（新包），conversation-compose 接线，identityPlugin 注入

---

## 背景

当前 agent 每次 run 从零开始，没有跨 session 记忆。OMP 的 memory pipeline 通过两阶段 LLM 调用自动提取和合并经验，写入 agent workspace 的 MEMORY.md 和 memory_summary.md，在下次 session 启动时注入 system prompt。

## 调研

分析 OMP 的 `pi-coding-agent/src/memories/` 和 `pi-coding-agent/src/memory-backend/`。

### OMP 架构

```
每个 turn 结束
    ↓
AutoLearnController 监听 session 事件
    ↓
Stage 1 (per-thread 提取): 小模型 → { rollout_summary, rollout_slug, raw_memory }
    存储: SQLite memory.db — threads + stage1_outputs + jobs 表
    claim/lease 并发控制
    ↓
Stage 2 (cross-thread 合并): 收集所有 raw_memories → MEMORY.md + memory_summary.md + skills/
    存储: agent workspace 文件系统
    ↓
Injection: read-path.md 模板 → system prompt append
   memory://root URL protocol → 读取 memory_summary.md
```

### 多后端

OMP 支持 4 个互斥后端: off / local / hindsight / mnemopi。我们只用 **local**（最基础的文件态后端）。

### 关键 Prompt

| Phase | Prompt 文件 | 功能 |
|-------|-----------|------|
| Stage 1 system | `stage_one_system.md` | 提取器角色，JSON 输出 contract |
| Stage 1 input | `stage_one_input.md` | thread_id + response_items_json |
| Phase 2 system | `consolidation_system.md` | 合并器角色，"Return strict JSON only" |
| Phase 2 input | `consolidation.md` | raw_memories → { memory_md, memory_summary, skills[] } |
| Injection | `read-path.md` | 操作规则 + memory_summary + learned |

## 决策

### 简化：去掉 SQLite job queue

OMP 用 SQLite 做 job 并发控制（claim/lease/heartbeat）。我们只有一个 backend 进程，不需要 claim/lease。用 conversation ledger 的 `ts` 做增量判断——每个 agent 的 memory pipeline 只处理上次提取之后的新 ledger entries。

### 简化：去掉 learn 工具

OMP 有 `learn` tool + `autolearn` controller。我们的 agent 不主动调用 learn——全靠后台 pipeline 自动提取。跟 recap 一样：每轮结束后异步跑一次小模型调用。

### 存储：agent workspace 文件系统

```text
<agentDir>/
├── MEMORY.md          # 长期记忆（Phase 2 输出）
├── memory_summary.md  # Prompt 注入摘要（Phase 2 输出）
└── .memory_state.json # Pipeline 状态（last_extracted_seq）
```

### 注入：identityPlugin beforeModel

`memory_summary.md` 在 `beforeRun` 时读取，注入到 system prompt 的 `<memory>` 标签中。已有 `fsMemoryPlugin` 做这件事——我们扩展它，或者让 identityPlugin 在 composeSystemPrompt 时注入。

### 时序

```
afterModel (每 run 结束)
  → 读取 conversation ledger 新条目（自 last_extracted_seq 以来）
  → 如果新条目 < 阈值 → 跳过
  → Stage 1: 小模型提取 → { raw_memory }
  → 追加到 .memory_state.json
  → 如果累积 >= 阈值 → Stage 2: 合并 → MEMORY.md + memory_summary.md
```

### 不做

- SQLite job queue + claim/lease（单进程无并发）
- `learn` tool（纯自动）
- `memory://` URL protocol（frontend 不需要）
- Hindsight/Mnemopi backends（OMP 专有）
- Secret redaction（可后加）

## 实现

1. `packages/plugin-memory` — 新包：beforeRun（注入）+ afterModel（提取）
2. 复用 OMP 的 stage_one prompt（JSON output contract）
3. Phase 2 合并 prompt 简化——只生成 MEMORY.md + memory_summary.md
4. identityPlugin 的 beforeModel 读取 memory_summary.md 注入 `<memory>` 标签
