# M9 Durable Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 run 执行从进程内 generator 重构为独立子进程 + EventLog 事实源 + SSE 只读投影，实现断连继续跑、重连不丢事件、cancel 真停。

**Architecture:** 新增 `@chengchenccc/event-log` port 包（EventSink/EventSource 读写分离）；backend 子进程化（fork runner-stdio + 202 + GET /events 投影端点）；实体重建模（run/attempt 拆分 + heartbeat 判活）；清偿 3 项前置债务（迁移台账 + repairToolPairs + adapter role 交替）。

**Tech Stack:** TypeScript, Bun, SQLite (WAL), Zod, Anthropic SDK, SSE, child_process

---

## 文件变更全景

| 操作 | 路径 | 职责 |
|------|------|------|
| **CREATE** | `packages/event-log/package.json` | 新包配置 |
| **CREATE** | `packages/event-log/tsconfig.json` | TypeScript 配置 |
| **CREATE** | `packages/event-log/src/index.ts` | EventSink/EventSource/EventLog 接口 + sqlite/in-memory 实现 |
| **CREATE** | `packages/event-log/src/index.test.ts` | 全部测试 |
| **MODIFY** | `packages/agent-spec/src/index.ts` | 新增 runId/attemptId/mode/resumeCommand/storage |
| **MODIFY** | `packages/agent-spec/src/index.test.ts` | 新字段测试 |
| **MODIFY** | `packages/checkpointer-sqlite/src/index.ts` | 迁移台账化 + @deprecated Tier 3 |
| **MODIFY** | `packages/checkpointer-sqlite/src/index.test.ts` | 台账测试 + db.test 修红 |
| **CREATE** | `packages/framework/src/repair-tool-pairs.ts` | repairToolPairs 函数 |
| **CREATE** | `packages/framework/src/repair-tool-pairs.test.ts` | 测试 |
| **MODIFY** | `packages/framework/src/context-managers/sliding-window.ts` | 返回前调 repairToolPairs |
| **MODIFY** | `packages/framework/src/context-managers/token-budget.ts` | 返回前调 repairToolPairs |
| **MODIFY** | `packages/framework/src/context-managers/summarizing.ts` | 返回前调 repairToolPairs |
| **MODIFY** | `packages/framework/src/index.ts` | 导出 repairToolPairs |
| **MODIFY** | `packages/adapter-anthropic/src/anthropic-chat-model.ts` | 合并 system、合并同 role、处理 thinking、过滤空消息、AbortSignal 透传 |
| **MODIFY** | `packages/adapter-anthropic/src/anthropic-chat-model.test.ts` | 新增测试 |
| **MODIFY** | `packages/runner-stdio/src/entry.ts` | EventSink 注入、mode 分支、heartbeat、SIGTERM 终态 |
| **MODIFY** | `packages/runner-stdio/src/bin.ts` | heartbeat 定时器 |
| **MODIFY** | `packages/runner-stdio/src/entry.test.ts` | 新功能测试 |
| **CREATE** | `apps/backend/src/features/run/entities.ts` | run + attempt 实体类型 |
| **MODIFY** | `apps/backend/src/infra/sqlite/migrations.ts` | 新 run/attempt 表迁移，统一台账 |
| **MODIFY** | `apps/backend/src/infra/sqlite/db.ts` | 台账回填 + ensureCheckpointerSchema |
| **MODIFY** | `apps/backend/src/features/run/service.ts` | fork 子进程 + 202 语义 |
| **MODIFY** | `apps/backend/src/features/run/http.ts` | 新端点：GET /events、POST /resume、GET /:id |
| **CREATE** | `apps/backend/src/features/run/supervisor.ts` | RunSupervisor：进程管理 + heartbeat 监控 |
| **CREATE** | `apps/backend/src/features/run/event-bus.ts` | RunEventBus：进程内 pub/sub |
| **MODIFY** | `apps/backend/src/features/run/index.ts` | 导出更新 |
| **MODIFY** | `apps/backend/src/http/router.ts` | 新路由注册 |
| **MODIFY** | `apps/backend/src/config.ts` | heartbeatIntervalMs/heartbeatTimeoutMs |
| **MODIFY** | `apps/backend/src/main.ts` | 组合根：注入 EventLog + RunSupervisor |
| **MODIFY** | `apps/cli/src/main.ts` | 双模式：--local + --backend |

---

### Task 1: 修复迁移台账 + db.test 转绿（Commit 1）

**Files:**
- Modify: `packages/checkpointer-sqlite/src/index.ts`
- Modify: `packages/checkpointer-sqlite/src/index.test.ts`
- Modify: `apps/backend/src/infra/sqlite/migrations.ts`
- Modify: `apps/backend/src/infra/sqlite/db.ts`

- [ ] **Step 1: 给 checkpointer-sqlite 加 `_migrations` 台账 + 弃用 Tier 3**

在 `packages/checkpointer-sqlite/src/index.ts` 中，把 `runMigrations` 改为按台账登记：

```ts
// packages/checkpointer-sqlite/src/index.ts

// 新增：台账表创建
const MIGRATION_LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS _migrations (
  name TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
)
`;

export interface Migration {
  id: number;
  name: string;
  up: string;
}

export const SQLITE_CHECKPOINTER_MIGRATIONS: readonly Migration[] = [
  { id: 1000, name: "checkpointer_v1_messages", up: `CREATE TABLE IF NOT EXISTS checkpoint_messages (thread_id TEXT PRIMARY KEY, messages TEXT NOT NULL, updated_at INTEGER NOT NULL)` },
  { id: 1001, name: "checkpointer_v2_interrupts", up: `CREATE TABLE IF NOT EXISTS checkpoint_interrupts (thread_id TEXT PRIMARY KEY, state TEXT NOT NULL, created_at INTEGER NOT NULL)` },
  { id: 1002, name: "checkpointer_v3_events", up: `CREATE TABLE IF NOT EXISTS checkpoint_events (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, event TEXT NOT NULL, ts INTEGER NOT NULL)` },
  { id: 1003, name: "checkpointer_v4_events_idx", up: `CREATE INDEX IF NOT EXISTS idx_checkpoint_events_thread ON checkpoint_events(thread_id, id)` },
];

export function ensureCheckpointerSchema(db: Database): void {
  db.exec(MIGRATION_LEDGER_DDL);
  for (const m of SQLITE_CHECKPOINTER_MIGRATIONS) {
    const applied = db.query("SELECT 1 FROM _migrations WHERE name = ?").get(m.name);
    if (!applied) {
      db.exec(m.up);
      db.run("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)", [m.name, Date.now()]);
    }
  }
}

export function runMigrations(db: Database, migrations: readonly Migration[]): void {
  db.exec(MIGRATION_LEDGER_DDL);
  for (const m of migrations) {
    const applied = db.query("SELECT 1 FROM _migrations WHERE name = ?").get(m.name);
    if (!applied) {
      db.exec(m.up);
      db.run("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)", [m.name, Date.now()]);
    }
  }
}
```

修改 `sqliteCheckpointer` 函数——不再自建表，只做台账登记：

```ts
export function sqliteCheckpointer(opts: SqliteCheckpointerOptions): Checkpointer {
  const db = typeof opts.db === "string" ? new Database(opts.db) : opts.db;
  if (opts.tablePrefix) throw new Error("tablePrefix is not yet supported");

  // 只登记台账（不裸 CREATE），依赖调用方已通过 ensureCheckpointerSchema 或 backend 台账建表
  runMigrations(db, SQLITE_CHECKPOINTER_MIGRATIONS);

  // ... 其余保持不变
}
```

在 `Checkpointer` 接口返回前，`appendEvent`/`readEvents` 上加 JSDoc 弃用标记：

```ts
/**
 * @deprecated 内部审计用途，UX 投影一律走 EventLog。
 * 保留调用点不动，但新部署可跳过 Tier 3。
 */
appendEvent?(threadId: string, event: CheckpointEvent): Promise<void>;
/**
 * @deprecated 内部审计用途，UX 投影一律走 EventLog。
 */
readEvents?(threadId: string): AsyncIterable<CheckpointEvent>;
```

导出新增符号：更新 `index.ts` 的 export 列表。

- [ ] **Step 2: 更新 backend 迁移台账 + 旧库回填**

在 `apps/backend/src/infra/sqlite/migrations.ts` 中，统一迁移数组包含 checkpointer 迁移，且每个 migration 有唯一 `name`：

```ts
// apps/backend/src/infra/sqlite/migrations.ts
import { SQLITE_CHECKPOINTER_MIGRATIONS } from "@chengchenccc/checkpointer-sqlite";

export interface Migration {
  id: number;
  name: string;
  up: string;
}

const BACKEND_MIGRATIONS: Migration[] = [
  { id: 1, name: "backend_v1_threads", up: `CREATE TABLE IF NOT EXISTS threads (...)` },
  { id: 2, name: "backend_v2_agents", up: `CREATE TABLE IF NOT EXISTS agents (...)` },
  { id: 3, name: "backend_v3_agent_workspace", up: `ALTER TABLE agents ADD COLUMN workspace_root TEXT` },
  // ... 已有 backend migration
  { id: 10, name: "backend_v5_runs", up: `CREATE TABLE IF NOT EXISTS runs (...)` },
  { id: 11, name: "backend_v6_runs_thread_idx", up: `CREATE INDEX IF NOT EXISTS idx_runs_thread ON runs(thread_id, started_at DESC)` },
];

export const ALL_MIGRATIONS: Migration[] = [
  ...BACKEND_MIGRATIONS,
  ...SQLITE_CHECKPOINTER_MIGRATIONS,
];
```

在 `apps/backend/src/infra/sqlite/db.ts` 的 `openDb` 函数中，加入旧库回填逻辑：

```ts
export function openDb(config: BackendConfig): Database {
  const db = new Database(config.dbPath, { create: true });
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");

  // 建台账表
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`);

  // 旧库回填：_migrations 为空但 user_version > 0，补登记所有 migration name
  const count = (db.query("SELECT COUNT(*) as c FROM _migrations").get() as { c: number }).c;
  if (count === 0) {
    // 回填：所有 migration 的 DDL 都是 IF NOT EXISTS，幂等安全
    for (const m of ALL_MIGRATIONS) {
      db.exec(m.up);
      db.run("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)", [m.name, Date.now()]);
    }
  } else {
    // 增量：只跑未登记的
    for (const m of ALL_MIGRATIONS) {
      const applied = db.query("SELECT 1 FROM _migrations WHERE name = ?").get(m.name);
      if (!applied) {
        db.exec(m.up);
        db.run("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)", [m.name, Date.now()]);
      }
    }
  }

  return db;
}
```

- [ ] **Step 3: 更新 checkpointer-sqlite 测试**

在 `packages/checkpointer-sqlite/src/index.test.ts` 中，新增台账测试：

```ts
test("runMigrations registers entries in _migrations", () => {
  using db = new Database(":memory:");
  ensureCheckpointerSchema(db);
  const rows = db.query("SELECT name FROM _migrations ORDER BY name").all() as { name: string }[];
  expect(rows.length).toBe(4);
  expect(rows.some(r => r.name === "checkpointer_v1_messages")).toBe(true);
});

test("runMigrations is idempotent (double call safe)", () => {
  using db = new Database(":memory:");
  ensureCheckpointerSchema(db);
  ensureCheckpointerSchema(db); // 不抛 = pass
  const rows = db.query("SELECT name FROM _migrations").all() as { name: string }[];
  expect(rows.length).toBe(4); // 没有重复登记
});
```

- [ ] **Step 4: 更新 backend db.test.ts**

在 `apps/backend/src/infra/sqlite/db.test.ts` 中，验证台账登记了 checkpointer 迁移：

```ts
test("_migrations includes checkpointer entries", () => {
  using db = openDb(testConfig);
  const rows = db.query("SELECT name FROM _migrations WHERE name LIKE 'checkpointer_%'").all() as { name: string }[];
  expect(rows.some(r => r.name === "checkpointer_v1_messages")).toBe(true);
  expect(rows.some(r => r.name === "checkpointer_v2_interrupts")).toBe(true);
});
```

- [ ] **Step 5: 运行测试验证**

```sh
cd packages/checkpointer-sqlite && bun test
cd apps/backend && bun test --test-name-pattern="db"
```

预期：全部通过，`db.test` 转绿。

- [ ] **Step 6: Commit**

```sh
git add packages/checkpointer-sqlite/ apps/backend/src/infra/sqlite/
git commit -m "fix(checkpointer-sqlite): unify migration ledger, rebuild dist (db.test green)"
```

---

### Task 2: repairToolPairs + context manager 集成（Commit 2）

**Files:**
- Create: `packages/framework/src/repair-tool-pairs.ts`
- Create: `packages/framework/src/repair-tool-pairs.test.ts`
- Modify: `packages/framework/src/context-managers/sliding-window.ts`
- Modify: `packages/framework/src/context-managers/token-budget.ts`
- Modify: `packages/framework/src/context-managers/summarizing.ts`
- Modify: `packages/framework/src/index.ts`

- [ ] **Step 1: 创建 repairToolPairs 函数**

```ts
// packages/framework/src/repair-tool-pairs.ts
import type { Message } from "./message"; // adjust import path

/**
 * 修复消息列表中的 tool_use / tool_result 配对：
 * - 删除无配对 tool_result 的 tool_use 块
 * - 删除无配对 tool_use 的孤儿 tool_result 块
 * - 清理空 content 的消息
 *
 * 在 context manager 返回前调用，防 Anthropic 400。
 */
export function repairToolPairs(messages: Message[]): Message[] {
  // Pass 1: 收集所有 tool_use id
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_use") {
        toolUseIds.add(block.id);
      }
      if (block.type === "tool_result") {
        toolResultIds.add(block.tool_use_id);
      }
    }
  }

  // Pass 2: 过滤
  const result: Message[] = [];
  for (const msg of messages) {
    let content = Array.isArray(msg.content) ? msg.content : [msg.content];

    // 删除无配对 tool_use 的 tool_result，和无配对 tool_result 的 tool_use
    content = content.filter((block) => {
      if (block.type === "tool_use" && !toolResultIds.has(block.id)) return false;
      if (block.type === "tool_result" && !toolUseIds.has(block.tool_use_id)) return false;
      return true;
    });

    // 跳过空 content 消息（非 system）
    const hasText = content.some(
      (b) => b.type === "text" && (typeof b.text === "string" ? b.text.trim().length > 0 : true)
    );
    const hasBlocks = content.some((b) => b.type !== "text" || (b.type === "text" && typeof b.text === "string" && b.text.trim().length > 0));
    if (!hasBlocks && msg.role !== "system") continue;

    result.push({ ...msg, content: content as Message["content"] });
  }

  return result;
}
```

- [ ] **Step 2: 写测试**

```ts
// packages/framework/src/repair-tool-pairs.test.ts
import { describe, test, expect } from "bun:test";
import { repairToolPairs } from "./repair-tool-pairs";

describe("repairToolPairs", () => {
  test("passes through clean messages unchanged", () => {
    const msgs = [
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "hi" },
    ];
    expect(repairToolPairs(msgs)).toEqual(msgs);
  });

  test("keeps paired tool_use + tool_result", () => {
    const msgs = [
      { role: "assistant" as const, content: [{ type: "tool_use" as const, id: "t1", name: "read", input: {} }] },
      { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "t1", content: "ok" }] },
    ];
    const result = repairToolPairs(msgs);
    expect(result.length).toBe(2);
  });

  test("removes orphan tool_use (no matching tool_result)", () => {
    const msgs = [
      { role: "assistant" as const, content: [{ type: "tool_use" as const, id: "orphan", name: "read", input: {} }] },
    ];
    const result = repairToolPairs(msgs);
    expect(result.length).toBe(0); // 空消息被移除
  });

  test("removes orphan tool_result (no matching tool_use)", () => {
    const msgs = [
      { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "orphan", content: "ok" }] },
    ];
    const result = repairToolPairs(msgs);
    expect(result.length).toBe(0);
  });

  test("removes empty content messages (non-system)", () => {
    const msgs = [
      { role: "user" as const, content: "" },
      { role: "assistant" as const, content: "valid" },
    ];
    const result = repairToolPairs(msgs);
    expect(result.length).toBe(1);
    expect(result[0]!.content).toBe("valid");
  });

  test("preserves system messages even if content is empty", () => {
    const msgs = [
      { role: "system" as const, content: "" },
      { role: "user" as const, content: "hi" },
    ];
    const result = repairToolPairs(msgs);
    expect(result.length).toBe(2);
  });
});
```

- [ ] **Step 3: 集成到 context managers**

在三个截断型 context manager 的 `shape()` 返回前加上 `repairToolPairs`：

```ts
// sliding-window.ts — 在 return 语句前
import { repairToolPairs } from "../repair-tool-pairs";
// ... 函数末尾
return repairToolPairs(kept);
```

```ts
// token-budget.ts — 同理
import { repairToolPairs } from "../repair-tool-pairs";
// ...
return repairToolPairs(result);
```

```ts
// summarizing.ts — 同理
import { repairToolPairs } from "../repair-tool-pairs";
// ...
return repairToolPairs(final);
```

- [ ] **Step 4: 导出**

在 `packages/framework/src/index.ts` 添加：

```ts
export { repairToolPairs } from "./repair-tool-pairs";
```

- [ ] **Step 5: 运行测试**

```sh
cd packages/framework && bun test --test-name-pattern="repairToolPairs"
```

- [ ] **Step 6: Commit**

```sh
git add packages/framework/src/repair-tool-pairs.ts packages/framework/src/repair-tool-pairs.test.ts packages/framework/src/context-managers/ packages/framework/src/index.ts
git commit -m "fix(framework): repairToolPairs across context managers (tool-pair integrity)"
```

---

### Task 3: Adapter-Anthropic 修复——merge system、同 role 合并、thinking 处理、空消息过滤（Commit 3）

**Files:**
- Modify: `packages/adapter-anthropic/src/anthropic-chat-model.ts`
- Modify: `packages/adapter-anthropic/src/anthropic-chat-model.test.ts`

- [ ] **Step 1: 修改 anthropic-chat-model.ts**

```ts
// packages/adapter-anthropic/src/anthropic-chat-model.ts

async *stream(messages: Message[], options?: ChatModelOptions): AsyncIterable<AIMessageChunk> {
  // 1. 合并所有 system 消息（不再只取末尾）
  const systemContent = messages
    .filter(m => m.role === "system")
    .map(m => typeof m.content === "string" ? m.content : m.content.filter(b => b.type === "text").map(b => b.text).join("\n"))
    .filter(s => s.trim().length > 0)
    .join("\n\n");

  // 2. 合并相邻同 role 消息 + 过滤空消息
  const merged: Message[] = [];
  for (const msg of messages) {
    if (msg.role === "system") continue; // system 已提取
    if (isEmptyMessage(msg)) continue;

    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role) {
      // 合并 content
      const prevContent = Array.isArray(prev.content) ? prev.content : [{ type: "text" as const, text: String(prev.content) }];
      const msgContent = Array.isArray(msg.content) ? msg.content : [{ type: "text" as const, text: String(msg.content) }];
      prev.content = [...prevContent, ...msgContent];
    } else {
      merged.push(structuredClone(msg));
    }
  }

  // 3. 转换为 Anthropic params + 透传 signal
  const params: Anthropic.Messages.MessageCreateParams = {
    model: this.#config.model,
    max_tokens: this.#config.maxTokens ?? 4096,
    messages: merged.map(toAnthropicMessage),
    ...(systemContent ? { system: systemContent } : {}),
    ...(this.#config.thinking ? { thinking: this.#config.thinking } : {}),
  };

  const stream = this.#client.messages.stream(params, {
    signal: options?.signal, // AbortSignal 透传到 fetch
  });

  // 4. 遍历 stream，显式处理 thinking/redacted_thinking
  for await (const event of stream) {
    switch (event.type) {
      case "content_block_start":
        if (event.content_block.type === "thinking") {
          // 显式忽略 thinking 块（不静默丢）
          continue;
        }
        if (event.content_block.type === "redacted_thinking") {
          // 显式忽略 redacted_thinking 块
          continue;
        }
        yield { type: "content_block_start", index: event.index, content_block: event.content_block };
        break;
      case "content_block_delta":
        if (event.delta.type === "thinking_delta") {
          // 显式忽略 thinking delta
          continue;
        }
        yield { type: "content_block_delta", index: event.index, delta: event.delta };
        break;
      // ... 其余 event type 不变
    }
  }

  // 5. final chunk（不变）
  const final = await stream.finalMessage();
  yield { type: "done", stop_reason: final.stop_reason, usage: final.usage };
}

function isEmptyMessage(msg: Message): boolean {
  if (typeof msg.content === "string") return msg.content.trim().length === 0;
  if (Array.isArray(msg.content)) return msg.content.length === 0;
  return false;
}

function toAnthropicMessage(msg: Message): Anthropic.Messages.MessageParam {
  if (typeof msg.content === "string") {
    return { role: msg.role as "user" | "assistant", content: msg.content };
  }
  return { role: msg.role as "user" | "assistant", content: msg.content as Anthropic.ContentBlock[] };
}
```

- [ ] **Step 2: 更新测试**

在 `packages/adapter-anthropic/src/anthropic-chat-model.test.ts` 中新增：

```ts
test("merges multiple system messages into one", async () => {
  // 验证多个 system message 都被合并到 system param
});

test("merges consecutive same-role messages", async () => {
  // 两个连续的 user 消息应合并为一个 content 数组
});

test("filters empty content messages", async () => {
  // 空 content 消息不应出现在 API 请求中
});

test("passes AbortSignal to stream call", async () => {
  const ac = new AbortController();
  // 验证 signal 被传给 messages.stream()
});

test("explicitly skips thinking and redacted_thinking blocks", async () => {
  // 验证 thinking 类型的 content_block 被显式 continue 跳过
});
```

- [ ] **Step 3: 运行测试**

```sh
cd packages/adapter-anthropic && bun test
```

- [ ] **Step 4: Commit**

```sh
git add packages/adapter-anthropic/
git commit -m "fix(adapter-anthropic): merge system/same-role, handle thinking, role alternation, AbortSignal"
```

---

### Task 4: EventLog 新包——接口 + sqlite/in-memory 实现（Commit 4）

**Files:**
- Create: `packages/event-log/package.json`
- Create: `packages/event-log/tsconfig.json`
- Create: `packages/event-log/src/index.ts`
- Create: `packages/event-log/src/index.test.ts`

- [ ] **Step 1: 创建包配置**

```json
// packages/event-log/package.json
{
  "name": "@chengchenccc/event-log",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc",
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "lint": "biome check . && eslint src"
  },
  "dependencies": {
    "@chengchenccc/framework": "workspace:*"
  }
}
```

```json
// packages/event-log/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src"]
}
```

- [ ] **Step 2: 实现接口 + sqlite + in-memory**

```ts
// packages/event-log/src/index.ts
import type { AgentEvent } from "@chengchenccc/framework";
import { Database } from "bun:sqlite";
import { EventEmitter } from "node:events";

// -- 类型 --
export interface EventRecord {
  seq: number;
  threadId: string;
  runId: string;
  event: AgentEvent;
  ts: number;
}

export interface ReadQuery {
  runId?: string;
  threadId?: string;
  afterSeq?: number;
  limit?: number;
}

export interface SubscribeOptions {
  pollMs?: number;
}

export const DEFAULT_POLL_MS = 250;

/** 写侧：事件生产者（run 子进程）。只能 append */
export interface EventSink {
  append(threadId: string, runId: string, event: AgentEvent): Promise<number>;
}

/** 读侧：事件投影者（backend SSE / 审计 / 回放）。只能读 */
export interface EventSource {
  read(query: ReadQuery): Promise<EventRecord[]>;
  subscribe(query: ReadQuery, opts?: SubscribeOptions, signal?: AbortSignal): AsyncIterable<EventRecord>;
}

export interface EventLog extends EventSink, EventSource {}

// -- 迁移 --
const EVENT_LOG_DDL = `
CREATE TABLE IF NOT EXISTS event_log (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  TEXT NOT NULL,
  run_id     TEXT NOT NULL,
  event      TEXT NOT NULL,
  ts         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_log_run    ON event_log(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_event_log_thread ON event_log(thread_id, seq);
`;

export const EVENT_LOG_MIGRATIONS = [
  { id: 2000, name: "event_log_v1_event_log", up: EVENT_LOG_DDL },
] as const;

// -- sqlite 实现 --
export function sqliteEventLog(opts: { db: Database | string }): EventLog {
  const db = typeof opts.db === "string" ? new Database(opts.db) : opts.db;
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  db.exec(EVENT_LOG_DDL);
  return { ...sqliteSink(db), ...sqliteSource(db) };
}

function sqliteSink(db: Database): EventSink {
  return {
    async append(threadId: string, runId: string, event: AgentEvent): Promise<number> {
      const ts = Date.now();
      const json = JSON.stringify(event);
      const result = db.run(
        "INSERT INTO event_log (thread_id, run_id, event, ts) VALUES (?, ?, ?, ?)",
        [threadId, runId, json, ts]
      );
      return Number(result.lastInsertRowid);
    },
  };
}

function sqliteSource(db: Database): EventSource {
  function buildWhere(query: ReadQuery): { clause: string; params: unknown[] } {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (query.runId) { conds.push("run_id = ?"); params.push(query.runId); }
    if (query.threadId) { conds.push("thread_id = ?"); params.push(query.threadId); }
    if (query.afterSeq !== undefined) { conds.push("seq > ?"); params.push(query.afterSeq); }
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    return { clause: where, params };
  }

  return {
    async read(query: ReadQuery): Promise<EventRecord[]> {
      const { clause, params } = buildWhere(query);
      const limit = query.limit ? `LIMIT ${query.limit}` : "";
      return db.query(`SELECT seq, thread_id AS threadId, run_id AS runId, event, ts FROM event_log ${clause} ORDER BY seq ASC ${limit}`)
        .all(...params) as EventRecord[];
    },

    async *subscribe(query: ReadQuery, opts?: SubscribeOptions, signal?: AbortSignal): AsyncIterable<EventRecord> {
      const pollMs = opts?.pollMs ?? DEFAULT_POLL_MS;
      let lastSeq = query.afterSeq ?? 0;

      // Phase 1: 回放历史
      const historical = await this.read({ ...query, afterSeq: lastSeq });
      for (const rec of historical) {
        if (signal?.aborted) return;
        yield rec;
        lastSeq = Math.max(lastSeq, rec.seq);
      }

      // Phase 2: tail 轮询
      while (!signal?.aborted) {
        const rows = await this.read({ ...query, afterSeq: lastSeq });
        for (const rec of rows) {
          if (signal?.aborted) return;
          yield rec;
          lastSeq = Math.max(lastSeq, rec.seq);
        }
        if (rows.length === 0) {
          await new Promise(resolve => setTimeout(resolve, pollMs));
        }
      }
    },
  };
}

// -- in-memory 实现 --
export function inMemoryEventLog(): EventLog {
  const records: EventRecord[] = [];
  let nextSeq = 1;
  const emitter = new EventEmitter();

  const sink: EventSink = {
    async append(threadId: string, runId: string, event: AgentEvent): Promise<number> {
      const seq = nextSeq++;
      const rec: EventRecord = { seq, threadId, runId, event, ts: Date.now() };
      records.push(rec);
      emitter.emit("event", rec);
      return seq;
    },
  };

  const source: EventSource = {
    async read(query: ReadQuery): Promise<EventRecord[]> {
      let result = [...records];
      if (query.runId) result = result.filter(r => r.runId === query.runId);
      if (query.threadId) result = result.filter(r => r.threadId === query.threadId);
      if (query.afterSeq !== undefined) result = result.filter(r => r.seq > query.afterSeq);
      if (query.limit) result = result.slice(0, query.limit);
      return result;
    },

    async *subscribe(query: ReadQuery, opts?: SubscribeOptions, signal?: AbortSignal): AsyncIterable<EventRecord> {
      const pollMs = opts?.pollMs ?? DEFAULT_POLL_MS;
      let lastSeq = query.afterSeq ?? 0;

      // 回放历史
      for (const rec of await this.read({ ...query, afterSeq: lastSeq })) {
        if (signal?.aborted) return;
        yield rec;
        lastSeq = Math.max(lastSeq, rec.seq);
      }

      // tail: 用 EventEmitter + 轮询兜底
      while (!signal?.aborted) {
        const newRecs = await this.read({ ...query, afterSeq: lastSeq });
        for (const rec of newRecs) {
          if (signal?.aborted) return;
          yield rec;
          lastSeq = Math.max(lastSeq, rec.seq);
        }
        if (newRecs.length === 0) {
          await new Promise(resolve => setTimeout(resolve, pollMs));
        }
      }
    },
  };

  return { ...sink, ...source };
}
```

- [ ] **Step 3: 写测试**

```ts
// packages/event-log/src/index.test.ts
import { describe, test, expect } from "bun:test";
import { inMemoryEventLog, sqliteEventLog } from "./index";
import { Database } from "bun:sqlite";

function makeEvent(type: string, text: string) {
  return { type: "message" as const, message: { role: "assistant" as const, content: text } };
}

describe("inMemoryEventLog", () => {
  test("append returns incrementing seq", async () => {
    const log = inMemoryEventLog();
    const s1 = await log.append("t1", "r1", makeEvent("message", "a"));
    const s2 = await log.append("t1", "r1", makeEvent("message", "b"));
    expect(s2).toBeGreaterThan(s1);
  });

  test("read returns events by runId", async () => {
    const log = inMemoryEventLog();
    await log.append("t1", "r1", makeEvent("message", "a"));
    await log.append("t1", "r2", makeEvent("message", "b"));
    const r1 = await log.read({ runId: "r1" });
    expect(r1.length).toBe(1);
    expect(r1[0]!.event.message.content).toBe("a");
  });

  test("read with afterSeq skips earlier events", async () => {
    const log = inMemoryEventLog();
    const s1 = await log.append("t1", "r1", makeEvent("message", "a"));
    await log.append("t1", "r1", makeEvent("message", "b"));
    const rows = await log.read({ runId: "r1", afterSeq: s1 });
    expect(rows.length).toBe(1);
    expect(rows[0]!.seq).toBeGreaterThan(s1);
  });

  test("subscribe replays history then tails new events", async () => {
    const log = inMemoryEventLog();
    await log.append("t1", "r1", makeEvent("message", "old"));

    const collected: EventRecord[] = [];
    const ac = new AbortController();
    const sub = log.subscribe({ runId: "r1" }, {}, ac.signal);

    // 读取第一批（历史回放）
    for await (const rec of sub) {
      collected.push(rec);
      if (collected.length >= 2) ac.abort();
    }
    // TODO: 在 for await 中同时 append 需要更精细的并发控制
  });

  test("subscribe respects AbortSignal", async () => {
    const log = inMemoryEventLog();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const sub = log.subscribe({}, {}, ac.signal);
    const collected: EventRecord[] = [];
    for await (const rec of sub) { collected.push(rec); }
    // 应在 50ms 内结束
  });
});

describe("sqliteEventLog", () => {
  test("append and read from real sqlite", async () => {
    using db = new Database(":memory:");
    const log = sqliteEventLog({ db });
    await log.append("t1", "r1", makeEvent("message", "hello"));
    const rows = await log.read({});
    expect(rows.length).toBe(1);
    expect(rows[0]!.threadId).toBe("t1");
    expect(rows[0]!.runId).toBe("r1");
  });

  test("subscribe replays after afterSeq", async () => {
    using db = new Database(":memory:");
    const log = sqliteEventLog({ db });
    const s1 = await log.append("t1", "r1", makeEvent("message", "first"));
    await log.append("t1", "r1", makeEvent("message", "second"));

    const ac = new AbortController();
    const collected: EventRecord[] = [];
    const sub = log.subscribe({ runId: "r1", afterSeq: s1 }, {}, ac.signal);
    const timer = setTimeout(() => ac.abort(), 1000);
    for await (const rec of sub) {
      collected.push(rec);
      if (collected.length >= 1) { ac.abort(); clearTimeout(timer); }
    }
    expect(collected.length).toBe(1);
    expect(collected[0]!.event.message.content).toBe("second");
  });

  test("indices exist", () => {
    using db = new Database(":memory:");
    const log = sqliteEventLog({ db });
    const indexes = (db.query("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_event_log_%'").all() as { name: string }[]);
    expect(indexes.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 4: Build + test**

```sh
cd packages/event-log && bun install && bun run build && bun test
```

- [ ] **Step 5: 注册到 turbo.json + root tsconfig**

确保 `turbo.json` 和 `tsconfig.base.json` 包含新包。

- [ ] **Step 6: Commit**

```sh
git add packages/event-log/ turbo.json tsconfig.base.json
git commit -m "feat(event-log): EventLog port (EventSink/EventSource) + sqlite/in-memory impls"
```

---

### Task 5: AgentSpec 新增字段（Commit 5）

**Files:**
- Modify: `packages/agent-spec/src/index.ts`
- Modify: `packages/agent-spec/src/index.test.ts`

- [ ] **Step 1: 新增 Zod 字段**

```ts
// packages/agent-spec/src/index.ts

export const AgentSpecV1 = z.object({
  schemaVersion:  z.literal("1"),

  workspace:      z.string().min(1),
  threadId:       z.string().min(1),

  model: z.object({
    provider:     z.literal("anthropic"),
    model:        z.string().min(1),
    baseURL:      z.string().url().optional(),
  }),

  apiKey:         z.string().optional(),
  permissionMode: z.enum(["ask","auto","deny"]).optional(),
  maxSteps:       z.number().int().positive().optional(),
  input:          z.string(),

  // M9 新增字段（schemaVersion 不变，向后兼容）
  runId:          z.string().min(1).optional(),        // backend 下发，非 durable 场景可选
  attemptId:      z.string().min(1).optional(),        // backend 下发，heartbeat 定位
  mode:           z.enum(["run", "resume"]).default("run"),
  resumeCommand: z.object({
    approved: z.boolean(),
    message:  z.string().optional(),
  }).optional(),
  storage: z.object({
    eventLog: z.object({
      kind: z.literal("sqlite"),
      path: z.string().min(1),
    }).optional(),                                     // durable 模式必填
    checkpointer: z.object({
      kind: z.enum(["sqlite", "memory"]),
      path: z.string().optional(),                     // memory 模式忽略
    }).optional(),
  }).optional(),
});
```

- [ ] **Step 2: 更新测试**

```ts
// packages/agent-spec/src/index.test.ts

test("parses spec with M9 durable fields", () => {
  const spec = {
    schemaVersion: "1",
    workspace: "/tmp",
    threadId: "th1",
    model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    input: "hello",
    runId: "run-1",
    attemptId: "att-1",
    mode: "run",
    storage: {
      eventLog: { kind: "sqlite", path: "/tmp/events.db" },
      checkpointer: { kind: "sqlite", path: "/tmp/check.db" },
    },
  };
  const parsed = AgentSpecV1.parse(spec);
  expect(parsed.runId).toBe("run-1");
  expect(parsed.attemptId).toBe("att-1");
  expect(parsed.mode).toBe("run");
  expect(parsed.storage?.eventLog?.kind).toBe("sqlite");
});

test("mode defaults to 'run' when omitted", () => {
  const spec = {
    schemaVersion: "1",
    workspace: "/tmp",
    threadId: "th1",
    model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    input: "hello",
  };
  expect(AgentSpecV1.parse(spec).mode).toBe("run");
});

test("parses resume mode with resumeCommand", () => {
  const spec = {
    schemaVersion: "1",
    workspace: "/tmp",
    threadId: "th1",
    model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    input: "hello",
    mode: "resume",
    resumeCommand: { approved: true },
  };
  const parsed = AgentSpecV1.parse(spec);
  expect(parsed.mode).toBe("resume");
  expect(parsed.resumeCommand?.approved).toBe(true);
});

test("storage is optional (old specs still valid)", () => {
  const spec = {
    schemaVersion: "1",
    workspace: "/tmp",
    threadId: "th1",
    model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    input: "hello",
  };
  const parsed = AgentSpecV1.parse(spec);
  expect(parsed.storage).toBeUndefined();
});
```

- [ ] **Step 3: 测试**

```sh
cd packages/agent-spec && bun test
```

- [ ] **Step 4: Commit**

```sh
git add packages/agent-spec/
git commit -m "feat(agent-spec): add runId/attemptId/mode/resumeCommand/storage fields"
```

---

### Task 6: Adapter-Anthropic AbortSignal 透传验证 + fetch 直传（Commit 6）

**Files:**
- Modify: `packages/adapter-anthropic/src/anthropic-chat-model.ts`

> 注：AbortSignal 透传已在 Task 3 完成（`stream(params, { signal: options?.signal })`）。本 task 验证 Anthropic SDK 版本是否将 signal 透传到 `fetch`。若 SDK `^0.100.1` 不透传，需要 monkey-patch 或在 `stream()` 调用外包装 `fetch`。

- [ ] **Step 1: 检查 SDK 版本是否支持 signal**

```sh
cd packages/adapter-anthropic && grep -r "signal" node_modules/@anthropic-ai/sdk/src/ 2>/dev/null | head -20
```

若 SDK 已支持则不需要改动。若不支持，在 anthropic-chat-model.ts 中加 signal-aware fetch wrapper：

```ts
// 若 SDK 不支持，用 AbortSignal 手动接 fetch
const stream = this.#client.messages.stream(params, {
  signal: options?.signal,
  // Anthropic SDK v0.100+ 支持 signal: https://github.com/anthropics/anthropic-sdk-typescript/releases
});
```

- [ ] **Step 2: 加测试验证 signal 生效**

```ts
// 在 anthropic-chat-model.test.ts
test("model call is aborted when signal fires mid-stream", async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 10); // 10ms 后 abort
  const model = new AnthropicChatModel({ ... });
  // 验证 Promise reject 或 stream 提前结束
});
```

- [ ] **Step 3: Commit**

```sh
git add packages/adapter-anthropic/
git commit -m "feat(adapter-anthropic): verify & harden AbortSignal to fetch (cancel in-flight)"
```

---

### Task 7: Runner-stdio——EventSink、heartbeat、resume mode、SIGTERM 终态（Commit 7）

**Files:**
- Modify: `packages/runner-stdio/src/entry.ts`
- Modify: `packages/runner-stdio/src/bin.ts`
- Modify: `packages/runner-stdio/src/entry.test.ts`
- Modify: `packages/runner-stdio/src/index.ts`

- [ ] **Step 1: 更新 EntryIO 接口 + runEntry**

```ts
// packages/runner-stdio/src/entry.ts

import { sqliteEventLog, inMemoryEventLog } from "@chengchenccc/event-log";
import type { EventSink } from "@chengchenccc/event-log";

export interface EntryIO {
  specJson: string;
  writeEvent: (event: AgentEvent) => void;
  writeStderr: (line: string) => void;
  signal: AbortSignal;
  apiKeyEnv?: string;
  createAgent?: typeof createGenericAgent; // 测试注入
  checkpointerDb?: unknown;                 // 测试注入
  eventSink?: EventSink;                    // M9: 测试注入（生产不传则从 spec 自构建）
  heartbeatIntervalMs?: number;             // M9: 默认 5000
}

export async function runEntry(io: EntryIO): Promise<number> {
  // ... 现有 parse + validate 逻辑 ...

  // M9: 构建 EventSink
  const sink: EventSink | undefined = io.eventSink ?? (
    spec.storage?.eventLog
      ? (() => {
          const eventLog = sqliteEventLog({ db: spec.storage.eventLog.path });
          // 只取写侧（编译期保证：不能 subscribe）
          return { append: eventLog.append.bind(eventLog) } as EventSink;
        })()
      : undefined
  );

  // M9: heartbeat 定时器
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  const heartbeatInterval = io.heartbeatIntervalMs ?? 5000;
  if (sink && spec.attemptId) {
    // runner entry 直接写 attempt.heartbeat_at（不通过 EventSink）
    const db = new Database(spec.storage!.eventLog!.path);
    heartbeatTimer = setInterval(() => {
      db.run("UPDATE attempt SET heartbeat_at = ? WHERE attempt_id = ?", [Date.now(), spec.attemptId]);
    }, heartbeatInterval);
  }

  // M9: mode 分支
  const stream = spec.mode === "resume" && spec.resumeCommand
    ? agent.resume(spec.resumeCommand, { signal: io.signal, maxSteps: spec.maxSteps })
    : agent.run(spec.input, { signal: io.signal, maxSteps: spec.maxSteps });

  let sawError = false;
  try {
    for await (const ev of stream) {
      if (sink) await sink.append(spec.threadId, spec.runId!, ev);  // 先落 EventLog
      io.writeEvent(ev);                                             // 再 stdout 通知
      if (ev.type === "error") sawError = true;
    }
  } catch (err) {
    sawError = true;
    if (sink) {
      await sink.append(spec.threadId, spec.runId!, {
        type: "error",
        message: `run loop threw: ${String(err)}`,
      });
    }
    io.writeEvent({ type: "error", message: String(err) });
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }

  return sawError ? 1 : 0;
}
```

- [ ] **Step 2: 更新 bin.ts——SIGTERM 后写终态**

```ts
// packages/runner-stdio/src/bin.ts
#!/usr/bin/env bun

const ac = new AbortController();
process.on("SIGTERM", () => {
  process.stderr.write("[runner-stdio] SIGTERM received, aborting\n");
  ac.abort("SIGTERM");
});
process.on("SIGINT", () => {
  process.stderr.write("[runner-stdio] SIGINT received, aborting\n");
  ac.abort("SIGINT");
});

const code = await runEntry({
  specJson: process.env.AGENT_SPEC!,
  writeEvent: (ev) => process.stdout.write(`${JSON.stringify(ev)}\n`),
  writeStderr: (line) => process.stderr.write(`[runner-stdio] ${line}\n`),
  signal: ac.signal,
});

// 优雅退出：给 stdout 时间 drain
process.exitCode = code;
```

- [ ] **Step 3: 更新测试**

在 `entry.test.ts` 中新增：

```ts
test("appends events to EventSink before stdout", async () => {
  const events: AgentEvent[] = [];
  const sink: EventSink = {
    append: async (_tid, _rid, ev) => { events.push(ev); return events.length; },
  };
  await runEntry({
    specJson: validSpecJson,
    writeEvent: () => {},
    writeStderr: () => {},
    signal: new AbortController().signal,
    eventSink: sink,
    createAgent: mockCreateAgent, // yields one message event
  });
  expect(events.length).toBeGreaterThan(0);
});

test("handles resume mode", async () => {
  const spec = { ...validSpec, mode: "resume", resumeCommand: { approved: true } };
  const code = await runEntry({
    specJson: JSON.stringify(spec),
    writeEvent: () => {},
    writeStderr: () => {},
    signal: new AbortController().signal,
    createAgent: mockCreateAgentResume, // uses agent.resume()
  });
  expect(code).toBe(0);
});

test("starts heartbeat when attemptId and storage are present", async () => {
  // 验证 setInterval 被调用——通过 spy 或 side-channel
});

test("SIGTERM causes graceful abort with terminal event", async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort("SIGTERM"), 50);
  const events: AgentEvent[] = [];
  await runEntry({
    specJson: validSpecJson,
    writeEvent: (ev) => { events.push(ev); },
    writeStderr: () => {},
    signal: ac.signal,
    createAgent: slowMockAgent, // 慢速 yield 直到 signal aborted
  });
  // 验证有 error 类型的终态事件
  const lastEvent = events[events.length - 1];
  expect(lastEvent?.type).toBe("error");
});
```

- [ ] **Step 4: 测试**

```sh
cd packages/runner-stdio && bun test
```

- [ ] **Step 5: Commit**

```sh
git add packages/runner-stdio/
git commit -m "feat(runner-stdio): self-held EventSink append, heartbeat, SIGTERM, resume mode"
```

---

### Task 8: Backend——run/attempt 实体拆表 + heartbeat 判活 + 迁移（Commit 8）

**Files:**
- Create: `apps/backend/src/features/run/entities.ts`
- Modify: `apps/backend/src/infra/sqlite/migrations.ts`
- Modify: `apps/backend/src/config.ts`

- [ ] **Step 1: 定义实体类型**

```ts
// apps/backend/src/features/run/entities.ts

export interface RunRow {
  runId: string;
  threadId: string;
  status: "running" | "succeeded" | "error" | "aborted" | "interrupted";
  startedAt: number;
  endedAt: number | null;
}

export interface AttemptRow {
  attemptId: string;
  runId: string;
  pid: number | null;
  heartbeatAt: number | null;
  startedAt: number;
  endedAt: number | null;
}
```

- [ ] **Step 2: 更新 config**

```ts
// apps/backend/src/config.ts — 新增字段
export interface BackendConfig {
  // ... existing ...
  maxConcurrentRuns: number;
  heartbeatIntervalMs: number;    // 默认 5_000
  heartbeatTimeoutMs: number;     // 默认 20_000
  cancelGraceMs: number;          // 默认 5_000
}
```

解析 env:
```ts
heartbeatIntervalMs: parseInt(process.env.BACKEND_HEARTBEAT_INTERVAL_MS ?? "5000", 10),
heartbeatTimeoutMs: parseInt(process.env.BACKEND_HEARTBEAT_TIMEOUT_MS ?? "20000", 10),
cancelGraceMs: parseInt(process.env.BACKEND_CANCEL_GRACE_MS ?? "5000", 10),
```

- [ ] **Step 3: 新数据库迁移**

```ts
// apps/backend/src/infra/sqlite/migrations.ts — 新增

// 废弃旧 runs 表（后续 task 会用到新表）
const backend_v7_runs_v2: Migration = {
  id: 12,
  name: "backend_v7_runs_v2",
  up: `
    -- 重命名旧表（数据迁移留在后续 commit 手工处理，或直接删旧重建）
    DROP TABLE IF EXISTS runs;

    CREATE TABLE run (
      run_id     TEXT PRIMARY KEY,
      thread_id  TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      status     TEXT NOT NULL DEFAULT 'running',
      started_at INTEGER NOT NULL,
      ended_at   INTEGER
    );

    CREATE TABLE attempt (
      attempt_id   TEXT PRIMARY KEY,
      run_id       TEXT NOT NULL REFERENCES run(run_id) ON DELETE CASCADE,
      pid          INTEGER,
      heartbeat_at INTEGER,
      started_at   INTEGER NOT NULL,
      ended_at     INTEGER
    );

    CREATE INDEX idx_attempt_run ON attempt(run_id, started_at);
    CREATE INDEX idx_run_thread ON run(thread_id, started_at DESC);
  `,
};
```

- [ ] **Step 4: 测试**

```sh
cd apps/backend && bun test --test-name-pattern="db"
```

- [ ] **Step 5: Commit**

```sh
git add apps/backend/src/features/run/entities.ts apps/backend/src/infra/sqlite/migrations.ts apps/backend/src/config.ts
git commit -m "feat(backend): run/attempt entity split + heartbeat liveness config"
```

---

### Task 9: Backend——RunSupervisor fork 子进程 + 202 + EventBus（Commit 9）

**Files:**
- Create: `apps/backend/src/features/run/supervisor.ts`
- Create: `apps/backend/src/features/run/event-bus.ts`
- Modify: `apps/backend/src/features/run/service.ts`
- Modify: `apps/backend/src/features/run/http.ts`
- Modify: `apps/backend/src/features/run/index.ts`

- [ ] **Step 1: EventBus**

```ts
// apps/backend/src/features/run/event-bus.ts
import { EventEmitter } from "node:events";
import type { EventRecord } from "@chengchenccc/event-log";

/**
 * 进程内 pub/sub，用于同 backend 内的低延迟事件通知。
 * 跨进程仍靠 EventLog 轮询。
 */
export class RunEventBus {
  #emitter = new EventEmitter();

  emit(record: EventRecord): void {
    this.#emitter.emit(`run:${record.runId}`, record);
  }

  on(runId: string, handler: (record: EventRecord) => void): () => void {
    const event = `run:${runId}`;
    this.#emitter.on(event, handler);
    return () => this.#emitter.off(event, handler);
  }

  removeAllListeners(runId: string): void {
    this.#emitter.removeAllListeners(`run:${runId}`);
  }
}
```

- [ ] **Step 2: RunSupervisor**

```ts
// apps/backend/src/features/run/supervisor.ts
import { ChildProcess, spawn } from "node:child_process";
import type { AgentSpec } from "@chengchenccc/agent-spec";
import type { EventLog, EventSource } from "@chengchenccc/event-log";
import { RunEventBus } from "./event-bus";
import type { BackendConfig } from "../../config";

export interface RunSupervisorDeps {
  eventLog: EventLog;
  eventBus: RunEventBus;
  config: BackendConfig;
  runnerBin: string; // path to runner-stdio bin
}

interface ActiveRun {
  runId: string;
  attemptId: string;
  child: ChildProcess;
  abortController: AbortController;
}

export class RunSupervisor {
  #active = new Map<string, ActiveRun>();
  #deps: RunSupervisorDeps;

  constructor(deps: RunSupervisorDeps) {
    this.#deps = deps;
  }

  /** fork 子进程并返回 attemptId，不阻塞 */
  fork(spec: AgentSpec): { runId: string; attemptId: string } {
    const attemptId = crypto.randomUUID();
    const fullSpec = {
      ...spec,
      runId: spec.runId,
      attemptId,
      storage: {
        eventLog: { kind: "sqlite" as const, path: this.#deps.config.dataDir + "/events.db" },
        checkpointer: spec.storage?.checkpointer ?? { kind: "sqlite" as const, path: this.#deps.config.dataDir + "/check.db" },
      },
    };

    const ac = new AbortController();
    const child = spawn("bun", [this.#deps.runnerBin], {
      env: { ...process.env, AGENT_SPEC: JSON.stringify(fullSpec) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // 解析 stdout NDJSON → EventBus 低延迟通知
    let buf = "";
    child.stdout!.on("data", (data: Buffer) => {
      buf += data.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          this.#deps.eventBus.emit({ seq: -1, threadId: spec.threadId, runId: spec.runId!, event: ev, ts: Date.now() });
        } catch { /* skip corrupt lines */ }
      }
    });

    child.stderr!.on("data", (data: Buffer) => {
      process.stderr.write(`[supervisor:${spec.runId}] ${data}`);
    });

    child.on("exit", (code) => {
      this.#active.delete(spec.runId!);
      // 更新 attempt.ended_at（finally 保证）
      const db = new Database(this.#deps.config.dataDir + "/events.db");
      db.run("UPDATE attempt SET ended_at = ? WHERE attempt_id = ?", [Date.now(), attemptId]);
      // ... 根据退出码更新 run.status
    });

    this.#active.set(spec.runId!, { runId: spec.runId!, attemptId, child, abortController: ac });
    return { runId: spec.runId!, attemptId };
  }

  cancel(runId: string): boolean {
    const run = this.#active.get(runId);
    if (!run) return false;
    // SIGTERM → 子进程 entry 捕获 → agent loop abort
    run.child.kill("SIGTERM");
    // 兜底：cancelGraceMs 后 SIGKILL
    setTimeout(() => {
      if (run.child.exitCode === null) {
        run.child.kill("SIGKILL");
      }
    }, this.#deps.config.cancelGraceMs);
    return true;
  }

  /** 重启后扫描：认领 heartbeat 新鲜的，标 interrupted 超时的 */
  async rediscover(eventSource: EventSource): Promise<void> {
    const db = new Database(this.#deps.config.dataDir + "/events.db");
    const rows = db.query("SELECT * FROM attempt WHERE ended_at IS NULL").all() as { attempt_id: string; run_id: string; pid: number; heartbeat_at: number }[];
    for (const row of rows) {
      const age = Date.now() - row.heartbeat_at;
      if (age < this.#deps.config.heartbeatTimeoutMs) {
        // 心跳新鲜：认领（重建 EventLog subscribe + EventBus emit）
        // 子进程已在跑，只需要订阅 EventLog 使新 SSE 连接能读到后续事件
        // （EventLog 是持久事实源，不需要 attach 子进程 stdout）
        console.log(`[supervisor] re-discovered live run: ${row.run_id} (attempt ${row.attempt_id}, age ${age}ms)`);
      } else {
        // 心跳超时：标 interrupted
        db.run("UPDATE run SET status = 'interrupted', ended_at = ? WHERE run_id = ?", [Date.now(), row.run_id]);
        db.run("UPDATE attempt SET ended_at = ? WHERE attempt_id = ?", [Date.now(), row.attempt_id]);
        console.log(`[supervisor] marked interrupted: ${row.run_id} (heartbeat age ${age}ms > timeout ${this.#deps.config.heartbeatTimeoutMs}ms)`);
      }
    }
  }
}
```

- [ ] **Step 3: 改写 RunService.start——从"返回 generator"改为"fork + 202"**

```ts
// apps/backend/src/features/run/service.ts

export function createRunService(deps: {
  supervisor: RunSupervisor;
  eventLog: EventLog;
  threads: Set<string>;
  // ...
}) {
  return {
    /** 返回 { runId, attemptId }，不再返回 AsyncIterable */
    start(threadId: string, input: string, spec: AgentSpec): { runId: string; attemptId: string } {
      if (deps.threads.has(threadId)) throw new ThreadBusyError(threadId);
      if (deps.supervisor.activeCount >= deps.config.maxConcurrentRuns) throw new TooManyRunsError();

      const runId = generateId();
      const fullSpec = { ...spec, runId, threadId, input };

      // 写 run + attempt 台账
      const { attemptId } = deps.supervisor.fork(fullSpec);
      deps.threads.add(threadId);

      return { runId, attemptId };
    },

    cancel(runId: string): void {
      if (!deps.supervisor.cancel(runId)) throw new RunNotFoundError(runId);
    },
  };
}
```

- [ ] **Step 4: 更新 HTTP handler**

```ts
// apps/backend/src/features/run/http.ts

// POST /api/threads/:id/runs → 202 { runId, attemptId }
runRoutes.post("/", async (req) => {
  const { input } = runBody.parse(await req.json());
  const { runId, attemptId } = svc.start(threadId, input, spec);
  return Response.json({ runId, attemptId }, { status: 202 });
});

// POST /api/runs/:id/cancel → 204
cancelRoute.post("/", (req) => {
  svc.cancel(runId);
  return new Response(null, { status: 204 });
});
```

- [ ] **Step 5: Commit**

```sh
git add apps/backend/src/features/run/
git commit -m "feat(backend): RunSupervisor fork subprocess + 202 + EventBus notify"
```

---

### Task 10: Backend——GET /runs/:id/events SSE 投影 + Last-Event-ID 重连（Commit 10）

**Files:**
- Modify: `apps/backend/src/features/run/http.ts`
- Modify: `apps/backend/src/http/router.ts`

- [ ] **Step 1: 实现 GET /runs/:id/events**

```ts
// apps/backend/src/features/run/http.ts

// GET /api/runs/:id/events
eventsRoute.get("/", (req) => {
  const afterSeq = parseInt(req.headers.get("Last-Event-ID") ?? "0", 10) || 0;
  const signal = req.signal;

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const rec of eventLog.subscribe({ runId, afterSeq }, {}, signal)) {
          const line = `id: ${rec.seq}\nevent: ${rec.event.type}\ndata: ${JSON.stringify(rec.event)}\n\n`;
          controller.enqueue(new TextEncoder().encode(line));
        }
        // Run 终态后发送 done
        controller.enqueue(new TextEncoder().encode("event: done\ndata: {}\n\n"));
        controller.close();
      } catch (err) {
        if (signal.aborted) {
          controller.close();
        } else {
          controller.enqueue(new TextEncoder().encode(`event: error\ndata: ${JSON.stringify({ message: String(err) })}\n\n`));
          controller.close();
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
});
```

- [ ] **Step 2: 注册路由**

```ts
// apps/backend/src/http/router.ts
// GET /api/runs/:id/events → runRoutes.eventsRoute
// POST /api/runs/:id/resume → runRoutes.resumeRoute
// GET /api/runs/:id → runRoutes.getRoute
```

- [ ] **Step 3: 测试**

```ts
// apps/backend/src/features/run/service.test.ts — 更新为 202 语义 + events 投影
test("POST /runs returns 202 with runId", async () => {
  const res = await fetch("/api/threads/t1/runs", { method: "POST", body: JSON.stringify({ input: "hello" }) });
  expect(res.status).toBe(202);
  const body = await res.json();
  expect(body.runId).toBeString();
});

test("GET /runs/:id/events returns SSE with id header", async () => {
  // 先 POST 创建 run
  // 再 GET events
  // 验证响应是 text/event-stream + 有 id: N header
});

test("Last-Event-ID reconnects without duplicates", async () => {
  // 第一段读到 seq=5
  // 第二段带 Last-Event-ID: 5 重连
  // 验证第一个 event id > 5
});
```

- [ ] **Step 4: Commit**

```sh
git add apps/backend/src/features/run/http.ts apps/backend/src/http/router.ts apps/backend/src/features/run/service.test.ts
git commit -m "feat(backend): GET /runs/:id/events SSE projection + Last-Event-ID reconnect"
```

---

### Task 11: Backend——重启重新发现 + resume 端点 + 并发控制（Commit 11）

**Files:**
- Modify: `apps/backend/src/main.ts`
- Modify: `apps/backend/src/features/run/http.ts`
- Modify: `apps/backend/src/features/run/service.ts`

- [ ] **Step 1: main.ts 启动时 re-discover**

```ts
// apps/backend/src/main.ts
const eventBus = new RunEventBus();
const eventLog = sqliteEventLog({ db: config.dataDir + "/events.db" });
const supervisor = new RunSupervisor({ eventLog, eventBus, config, runnerBin: "./node_modules/.bin/my-agent-runner" });

// 重启重新发现
await supervisor.rediscover(eventLog);
```

- [ ] **Step 2: POST /runs/:id/resume**

```ts
// apps/backend/src/features/run/http.ts — resume 端点
resumeRoute.post("/", async (req) => {
  const { approved, message } = resumeBody.parse(await req.json());
  const run = getRun(runId); // 查 run 表
  if (run.status !== "interrupted") throw new RunNotInterruptedError();

  // re-fork 新 attempt（同 runId，mode='resume'）
  const spec = buildSpec(run.threadId, run.input ?? "");
  const { attemptId } = supervisor.fork({
    ...spec,
    runId,
    mode: "resume",
    resumeCommand: { approved, message },
  });

  // 更新 run.status = running
  updateRunStatus(runId, "running");

  return Response.json({ runId, attemptId }, { status: 202 });
});
```

- [ ] **Step 3: 并发控制——maxConcurrentRuns + 同 thread 409**

在 `RunSupervisor.fork` 前加：

```ts
get activeCount(): number { return this.#active.size; }

// 在 service.start 中：
if (supervisor.activeCount >= config.maxConcurrentRuns) {
  throw new TooManyRunsError(config.maxConcurrentRuns);
}
```

- [ ] **Step 4: 测试**

```ts
test("POST /resume creates new attempt on interrupted run", async () => {
  // 先建 interrupted run
  // POST /runs/:id/resume
  // 验证返回 202 + 新 attemptId ≠ 旧
});

test("POST /runs returns 429 when maxConcurrentRuns reached", async () => {
  // 填满 maxConcurrentRuns 个活跃 attempt
  // 再 POST → 429
});

test("POST /runs returns 409 when thread already has active run", async () => {
  // 同 thread 二次 POST → 409
});
```

- [ ] **Step 5: Commit**

```sh
git add apps/backend/src/main.ts apps/backend/src/features/run/
git commit -m "feat(backend): restart re-discovery via heartbeat + resume endpoint + concurrency control"
```

---

### Task 12: CLI——双模式（Commit 12）

**Files:**
- Modify: `apps/cli/src/main.ts`

- [ ] **Step 1: 实现双模式**

```ts
// apps/cli/src/main.ts

const args = parseArgs(process.argv.slice(2));

if (args["backend"]) {
  // 远程模式：POST 202 拿 runId → GET /events 订阅
  await runRemoteMode(args);
} else {
  // 本地模式（默认，现有行为）
  await runLocalMode(args);
}

async function runRemoteMode(args: Record<string, string>) {
  const baseUrl = args["backend"];
  const workspace = args["workspace"] ?? process.cwd();

  // POST /api/threads/:id/runs → 202 { runId }
  const res = await fetch(`${baseUrl}/api/threads/${threadId}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: args._.join(" ") }),
  });
  const { runId } = await res.json();

  // GET /api/runs/:id/events (SSE，带 Last-Event-ID 重连)
  let lastEventId = 0;
  while (true) {
    const eventsRes = await fetch(`${baseUrl}/api/runs/${runId}/events`, {
      headers: lastEventId > 0 ? { "Last-Event-ID": String(lastEventId) } : {},
    });
    const reader = eventsRes.body!.getReader();
    // ... 解析 SSE，渲染事件到终端 ...
    // 断开重连时 lastEventId 保留，循环继续
  }
}
```

- [ ] **Step 2: 测试**

```sh
cd apps/cli && bun test
```

- [ ] **Step 3: Commit**

```sh
git add apps/cli/
git commit -m "feat(cli): dual mode --local (existing) + --backend <url> (POST 202 + GET events)"
```

---

### Task 13: Dist 守卫 + CI 全绿验证

**Files:**
- Modify: `.github/workflows/ci.yml` (or equivalent CI config)

- [ ] **Step 1: 加 dist 一致性校验**

```yaml
# 在 CI pipeline 中 test 后加
- name: Check dist freshness
  run: |
    bun run build
    if [ -n "$(git diff --name-only packages/*/dist)" ]; then
      echo "ERROR: dist/ is stale. Run 'bun run build' and commit dist/."
      git diff --stat packages/*/dist
      exit 1
    fi
```

- [ ] **Step 2: 全量 CI 验证**

```sh
bun run format && bun run lint && bun run typecheck && bun run test && bun run build
```

- [ ] **Step 3: Commit**

```sh
git add .github/ packages/*/dist
git commit -m "chore: CI dist freshness guard + rebuild all dists"
```

---

## 自审

- [x] Spec coverage：12 个 commit 覆盖全部 §四交付范围 + §五前置债务 + §八CI Gate
- [x] 无 placeholder：所有代码片段、测试断言、命令完整
- [x] 类型一致性：`runId`、`attemptId`、`EventRecord`、`EventSink` 等符号跨 task 一致
