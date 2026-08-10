# ADR: Memory Plugin 重构 + Autonomous Memory

**日期**: 2026-07-22
**状态**: design
**范围**: `packages/plugin-fs-memory` → `packages/plugin-memory`（改名 + 重构 + 新功能）

---

## 背景

当前 memory 功能分散在三个地方：

| 层 | 文件 | 职责 |
|---|------|------|
| agent 工具 | `plugin-fs-memory` | `memory_read` / `memory_write` / `memory_search` 工具，手动调用 |
| 注入 | `plugin-fs-memory` | beforeRun 读 MEMORY.md → MemoryKey context |
| 身份 | `agent-identity.ts` | 读 per-agent memory/ 文件构建 IdentityData.memories |

问题：手动提取、路径不统一（共享 workspace vs per-agent）、无自动机制。

## 目标

将 memory 所有权统一到 `plugin-memory` 包，agent-identity 退出 memory 角色。同时实现：
1. 包改名 + 切 per-agent cwd
2. memory_write 升级（batch + context 字段）
3. memory_search 升级（多词 AND + 时间过滤）
4. Autonomous Memory 自动提取（两阶段 LLM pipeline）

## 决策

### 1. 所有权统一：agent-identity 移除 readMemoryFacts

`agent-identity.ts` 的 `readMemoryFacts()` 负责读取 `memory/MEMORY.md` + `memory/facts/*.md`。这个职责移给 `plugin-memory`——它是唯一负责 memory I/O 的模块。identity 只负责 SOUL.md / USER.md / agent 身份。

### 2. 包改名：`plugin-fs-memory` → `plugin-memory`

`fs` 是实现细节（文件系统），随着自动提取加入，包名应反映领域语义。改名时保持仓库内引用一致。

### 3. cwd 切换：workspaceRoot → per-agent

`fsMemoryPlugin` 当前用 `config.workspaceRoot/memory/`（共享），改为 `config.dataDir/agents/<agentId>/memory/`（per-agent）。记忆是 agent 自身的，不是共享的。`agent-identity` 已用 per-agent 路径，此改动对齐。

### 4. memory_write 升级：抄 OMP retain

```yaml
# 当前（单个）
memory_write({ content: "Redis timeout is 5s" })

# 新（批量 + context）
memory_retain({
  items: [
    { content: "Redis timeout is 5s", context: "auth-service.ts login flow" },
    { content: "JWT expiry set to 15m", context: "middleware/auth.ts" },
  ]
})
```

context 字段帮助搜索——分词索引 context，匹配度加权。

### 5. memory_search 升级：多词 AND + 时间过滤

```
当前：memory_search({ query: "JWT login" })
  → grep "JWT login"（需要精确子串匹配）

新：memory_search({ query: "JWT login", since: "7d" })
  → 分 token: ["JWT", "login"]
  → 遍历 facts/ 文件（since 过滤 ISO 前缀）
  → 所有 token 都匹配 → 计算匹配密度 → 返回 top N + 片段
```

不引入新依赖（零 embedding/vector DB）。

### 6. Autonomous Memory 两阶段 pipeline

```
afterModel（每 run 结束）
    ↓ 读取 ledger 新条目（自 lastExtractedSeq）
    ↓ Stage 1: 小模型提取 → JSON [{ content, context, tags }]
    ↓ 写入 memory/facts/<ts>-<slug>.md（同 memory_retain 格式）
    ↓ 累积 >= 阈值 → Phase 2: LLM 合并 → MEMORY.md + memory_summary.md
    ↓ lastExtractedSeq = 最新 seq
```

Prompt 抄 OMP 的 `stage_one_system.md`（JSON output contract）和 `consolidation.md`（raw_memories → memory_md + memory_summary）。

### 不做

- `learn` tool（无 autolearn infra）
- `recall` 语义搜索（需 embedding/vector DB）
- SQLite job queue + claim/lease（单进程无并发）
- `memory://` URL protocol
- Hindsight / Mnemopi backends

## 影响

| 包 | 影响 |
|---|------|
| `plugin-fs-memory` → `plugin-memory` | 改名，加 auto-memory + retain + 搜索升级 |
| `agent-identity.ts` | 移除 `readMemoryFacts()`，只留 SOUL.md / USER.md |
| `agent-helpers.ts` | `fsMemoryPlugin` import 改为 `memoryPlugin` |
| `conversation-compose.ts` | `MemoryKey` import 路径更新 |
| 前端 | 无影响（memory 是 agent 内部功能） |

## 实现

1. `packages/plugin-fs-memory` → `packages/plugin-memory`（git mv）
2. 包内重命名：`fs-memory.ts` → `memory-plugin.ts`，加 `autoExtract` + `consolidateMemory`
3. 加 `memory-retain.ts`（批量 + context）
4. 升级 `memory-search.ts`（多词 AND + 时间过滤）
5. `agent-identity.ts` 移除 `readMemoryFacts`
6. `agent-helpers.ts` + `conversation-compose.ts` 更新 import
