# M20 Implementation Plan — Drizzle ORM 重构 · 手写 SQL → ORM · 手写迁移 → drizzle-kit

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将四套独立物理库的手写 SQLite SQL 用 Drizzle ORM 重写（除少数手写更高效/更清晰的 case），并将三套手写 migration 账本 + 一套 ad-hoc schema 统一迁移到 drizzle-kit 生成。**不考虑向后兼容**——直接以现有 schema 的最终形态定义 drizzle schema，drizzle-kit baseline 迁移即为现状的整体快照，旧的手写 migration 数组与自建 `_migrations` 账本随之删除。

**Architecture:** 四物理库各独立一份 drizzle schema + 一份 `drizzle.config.ts` + 一个独立的迁移目录，互不混账本。

| 物理库 | 位置 | owner | drizzle 目录 |
|---|---|---|---|
| `backend.db` | `<dataDir>/backend.db` | backend | `apps/backend/drizzle/backend/` |
| `events.db` | `<dataDir>/events.db` | backend supervisor | `apps/backend/drizzle/events/` |
| `checkpointer.sqlite` | 每 runner `<stateRoot>/`; harness `<cpDir>/db.sqlite` | framework + runner-daemon + harness | `packages/framework/drizzle/` |
| `bindings.sqlite` | 每 agent `<stateRoot>/lark-bot/<id>/bindings.sqlite` | lark-bot | `apps/lark-bot/drizzle/` |

**Tech Stack:** TypeScript, Bun, `drizzle-orm` (运行期，各使用包), `drizzle-kit` (构建期，root devDeps), `bun:sqlite`, Zod（保留 row 校验）。

**不做的事（Non-goals):** 不改任何业务行为/接口契约；不做数据迁移兼容（无历史库需要平滑升级——开发库可重建）；不动前端；不引入 PostgreSQL 等其他方言；不顺手优化 N+1 查询（纯 SQL 翻译，性能优化单开 PR）。

---

## 现状基线（实施前必读）

### 四套独立物理库

| 库 | 当前迁移机制 | 当前表数 | 最终存活 |
|---|---|---|---|
| `backend.db` | `ALL_MIGRATIONS` (`BACKEND_MIGRATIONS` + `SQLITE_CHECKPOINTER_MIGRATIONS` 拼接) → 自建 `_migrations` | 12 (含寄生 checkpoint_* 三表) | **9** — 不含 checkpoint_* 三表 |
| `events.db` | `EVENTS_DB_MIGRATIONS` → 自建 `_migrations` | 9 | 9 |
| `checkpointer.sqlite` | `SQLITE_CHECKPOINTER_MIGRATIONS` → 自建 `_migrations` | 3 | 3 |
| `bindings.sqlite` | `ensureSchema()` + `PRAGMA table_info`/`ALTER` 手写列迁移，无账本 | 5 | 5 |

### 关键事实

- **backend.db 不再建 checkpoint_* 表**：`ALL_MIGRATIONS` 合并 `SQLITE_CHECKPOINTER_MIGRATIONS` 是 M17.4 遗留——checkpointer 实际写入 `checkpointer.sqlite`（独立物理库），backend.db 里的 `checkpoint_interrupts`/`checkpoint_events` 永为空表。backend.db baseline 只建 9 张业务表。`checkpoint_messages` 已被 `projection_messages` 取代，不建。
- **agent archive 的两条 DELETE 是死代码**：`adapter-sqlite.ts:191-192` 的 `DELETE FROM checkpoint_interrupts/checkpoint_events` 删的永远是空表（checkpointer 不写 backend.db）。M20 随重建删除这两行，保留 `projection_messages` DELETE。
- **`consumeInterrupt` 读后删非原子**：`sqlite-checkpointer.ts:127-138` 是 `SELECT` 后单独 `DELETE`，无事务包裹——并发两个 consume 会重复消费。M20 借 drizzle 事务顺手原子化。
- **`tablePrefix` 是死代码**：`sqlite-checkpointer.ts:87` `if (prefix) throw`，`prefix` 恒为 `""`，`table()` 函数与所有 `prefix` 分支永不可达。M20 删除。
- **thread-projection `BEGIN IMMEDIATE` 已正确**：`thread-projection/adapter-sqlite.ts:26` 现状已是显式 `db.run("BEGIN IMMEDIATE")` + COMMIT/ROLLBACK，写锁级别本就正确。重写时保持显式 IMMEDIATE 事务边界，不可降级为 drizzle 默认事务（默认 DEFERRED）。

---

### 最终存活表（已 DROP 的不建模）

**backend.db (9 tables):**
- `agents`（+lark_* 四列, `workspace_path` UNIQUE, `idx_agents_archived`, `permission_mode` default `'ask'`）
- `conversation`（+title 可空, +origin NOT NULL default `'user'`, +trigger_mode default `'mention'`, +hop_count default 0）
- `member`（复合 PK `(conversation_id, member_id)`, FK→conversation CASCADE, `idx_member_conv`）
- `conversation_ledger`（seq AUTOINC PK, +run_id 可空, `addressed_to` default `'[]'`, FK CASCADE, `idx_ledger_conv`, 部分索引 `idx_ledger_run WHERE run_id IS NOT NULL`）
- `projection_messages`（PK `thread_id`）
- `issue`（PK `issue_id`, +description default `''`, +priority default `'P2'`, +estimated_completion_at 可空, `idx_issue_project`, `idx_issue_status`, 无 FK）
- `project`（PK, +auto_orchestrate INTEGER default 0, UNIQUE `idx_project_name`）
- `column_config`（PK, +approval_posture default `'auto'`, UNIQUE 复合 `idx_column_config_proj_status(project_id, status)`, `idx_column_config_project`）
- `deliverable`（PK, `idx_deliverable_issue`, `idx_deliverable_issue_kind`, UNIQUE 部分索引 `idx_deliverable_run_kind(run_id, kind) WHERE run_id IS NOT NULL`）

**events.db (9 tables):**
- `run`（PK `run_id`, +kind default `'main'`, +parent_run_id, +agent_id NOT NULL default `''`, +degraded_reason 可空, `status` default `'running'`, `idx_run_thread(thread_id, started_at DESC)` **DESC 方向必须保留**）
- `attempt`（PK, FK→run CASCADE, `idx_attempt_run(run_id, started_at)`）
- `run_ops_event`（seq AUTOINC, payload default `'{}'`, `idx_run_ops_event_run`, `idx_run_ops_event_trace`, `idx_run_ops_event_kind(kind, ts DESC)` **DESC**）
- `run_origin`（PK `run_id`, +issue_id 可空, +from_status default `''`, +origin_kind default `'manual'`, surface default `'web'`, UNIQUE `idx_run_origin_idem(idempotency_key)`, `idx_run_origin_trace`, `idx_run_origin_issue`）
- `runner_health`（PK `agent_id`, 多默认值列）
- `event_log`（seq AUTOINC, `idx_event_log_run`, `idx_event_log_thread`）
- `surface_health`（复合 PK `(agent_id, surface)`, payload default `'{}'`）
- `issue_event`（seq AUTOINC, `idx_issue_event_issue(issue_id, seq)`）

**checkpointer.sqlite (3 tables):**
- `checkpoint_messages`（PK `thread_id`, messages TEXT NOT NULL, updated_at INTEGER NOT NULL）
- `checkpoint_interrupts`（PK `thread_id`, state TEXT NOT NULL, created_at INTEGER NOT NULL）
- `checkpoint_events`（id AUTOINC PK, thread_id TEXT NOT NULL, event TEXT NOT NULL, ts INTEGER NOT NULL, `idx_checkpoint_events_thread(thread_id, id)`）

**bindings.sqlite (5 tables), 16 列已核对:**
- `chat_binding`
- `member_binding`
- `inbound_message`
- `run_stream`（16 列：`run_id, lark_chat_id, conversation_id, lark_message_id, source_message_id, typing_reaction_id, typing_status(DEFAULT 'none'), status(DEFAULT 'starting'), accumulated(DEFAULT ''), card_send_failed(DEFAULT 0), card_update_failed(DEFAULT 0), final_ledger_seq, last_error, complete_from_ledger(DEFAULT 0), created_at, updated_at`）
- `message_delivery`（复合唯一 `(conv_id, msg_id, chat_id)`）

**已 DROP 不建模：** backend.db 的 `threads`/`runs`/`run`/`attempt`/`checkpoint_messages`。

---

### 点名保留手写（用 `sql\`\`` 或整条保留 + 注释）

1. **`runtime-ops/service.ts` `listRuns`**：`WHERE 1=1` 动态 AND + `LIKE ? ESCAPE '\'` + 动态 LIMIT。
2. **`runtime-ops/service.ts`**：`json_extract(event,'$.type')`（SQLite JSON 函数，drizzle 无原生抽象）。
3. **`agent-svc-factory.ts` `assertNoActiveRun`**：忙检测子查询 + 动态 `IN`。
4. **`thread-projection/adapter.ts`**：显式 `BEGIN IMMEDIATE` 写锁事务（drizzle 默认事务非 IMMEDIATE，不可降级）。
5. **`column-config/adapter.ts`**：CASE-WHEN 状态排序（可用 `sql\`\`` 片段）。
6. **各处 `SELECT changes()` / `last_insert_rowid()`**：改用 drizzle `.run()` 返回的 `{ changes, lastInsertRowid }`。
7. **各 PRAGMA**（journal_mode/synchronous/busy_timeout/foreign_keys）：保留为连接初始化 `db.run(sql\`PRAGMA ...\`)`。
8. **派生列 `conversation_id || ':' || member_id`**：用 `sql\`... || ':' || ...\``。

---

## Part 0 — 脚手架与依赖

### Task 0.1: 安装 drizzle 依赖

**Files:**
- Modify: `apps/backend/package.json`
- Modify: `apps/lark-bot/package.json`
- Modify: `packages/framework/package.json`
- Modify: root `package.json`

- [ ] **Step 1: 安装运行期与开发期依赖**

```bash
cd /root/my-agent-team
bun add drizzle-orm --filter @chengchenccc/backend --filter @chengchenccc/lark-bot --filter @chengchenccc/framework
bun add -D drizzle-kit
```

- [ ] **Step 2:** `bun install` 成功，`bun.lock` 更新。
- [ ] **Step 3: Commit** `chore(deps): add drizzle-orm + drizzle-kit`

---

## Part 1 — backend.db schema + 连接 + baseline 迁移

### Task 1.1: 定义 backend schema

**Files:**
- Create: `apps/backend/src/infra/db/schema.ts`（backend.db 全部 9 张存活表，**不含** checkpoint_*）

- [ ] **Step 1:** 按附录逐表定义 `sqliteTable`，逐项核对：
  - `agents`：`workspace_path` 内联 `.unique()`；`permission_mode` default `'ask'`；lark_* 四列；索引 `idx_agents_archived`。
  - `conversation`：`origin` NOT NULL default `'user'`，`trigger_mode` default `'mention'`，`hop_count` default 0，`title` 可空。
  - `member`：复合主键 `(conversation_id, member_id)`（顺序固定）；FK `conversation_id`→conversation ON DELETE CASCADE；索引 `idx_member_conv`。
  - `conversation_ledger`：`seq` AUTOINCREMENT PK；`addressed_to` default `'[]'`（`text().default('[]')`）；`run_id` 可空；FK CASCADE；普通索引 `idx_ledger_conv(conversation_id, seq)`；部分索引 `idx_ledger_run(run_id) WHERE run_id IS NOT NULL`。
  - `projection_messages`：PK `thread_id`。
  - `issue`：PK `issue_id`；`description` default `''`、`priority` default `'P2'`、`estimated_completion_at` 可空；索引 `idx_issue_project`、`idx_issue_status`；无 FK。
  - `project`：PK；`auto_orchestrate` INTEGER default 0；唯一索引 `idx_project_name(name)`。
  - `column_config`：PK；`approval_posture` default `'auto'`；唯一复合索引 `idx_column_config_proj_status(project_id, status)` + 普通 `idx_column_config_project`。
  - `deliverable`：PK；索引 `idx_deliverable_issue`、`idx_deliverable_issue_kind(issue_id, kind)`；唯一部分索引 `idx_deliverable_run_kind(run_id, kind) WHERE run_id IS NOT NULL`。

- [ ] **Step 2:** `bun run --cwd apps/backend typecheck` 通过。
- [ ] **Step 3: Commit** `feat(backend): drizzle schema for backend.db (9 tables, no checkpoint_*)`

### Task 1.2: backend drizzle.config + baseline 迁移

**Files:**
- Create: `apps/backend/drizzle.backend.config.ts`
- Create: `apps/backend/drizzle/backend/`（迁移输出目录）

- [ ] **Step 1:** 写 config（`dialect: "sqlite"`, `schema: ./src/infra/db/schema.ts`, `out: ./drizzle/backend`, `dbCredentials` 指向开发库路径）。
- [ ] **Step 2:** `bunx drizzle-kit generate --config apps/backend/drizzle.backend.config.ts`，生成 baseline `0000_*.sql`。
- [ ] **Step 3:** 脚本 + 人工 diff baseline SQL vs 现状 schema：逐表逐索引核对列类型、默认值、复合主键顺序、部分索引 WHERE、唯一性。任何不一致回到 Task 1.1 修 schema 重新 generate。
- [ ] **Step 4: Commit** `feat(backend): drizzle-kit baseline migration for backend.db`

### Task 1.3: backend 连接与迁移 runner 切换

**Files:**
- Modify: `apps/backend/src/infra/sqlite/db.ts`（改为 drizzle 连接 + `migrate()`）
- Create: `apps/backend/src/infra/db/client.ts`（导出 `drizzle` 实例类型）

- [ ] **Step 1:** `openDb()` 改为：`new Database(path)` → 设 PRAGMA（WAL/synchronous）→ `drizzle(sqlite, { schema })` → `migrate(db, { migrationsFolder: "drizzle/backend" })`。返回 drizzle 实例（同时保留底层 `Database` 句柄，供保留手写 SQL 的 `sql\`\`` 使用）。
- [ ] **Step 2:** 删除 `ALL_MIGRATIONS` 拼接 + 手写循环 + 旧 `_migrations` 逻辑。删除 `...SQLITE_CHECKPOINTER_MIGRATIONS` 合并（checkpointer 完全独立）。
- [ ] **Step 3:** 全后端 typecheck 通过；启动 backend 对空库能完成迁移建表。
- [ ] **Step 4: Commit** `refactor(backend): drizzle connection + drizzle-kit migrate for backend.db`

---

## Part 2 — events.db schema + 连接 + baseline 迁移

### Task 2.1: 定义 events schema

**Files:**
- Create: `apps/backend/src/infra/db/events-schema.ts`

- [ ] **Step 1:** 按附录定义 events.db 全部 9 表，重点：
  - `run`：PK `run_id`，`status` default `'running'`，`kind` default `'main'`，`agent_id` NOT NULL default `''`，`degraded_reason` 可空；索引 `idx_run_thread(thread_id, started_at DESC)` —— **DESC 方向必须保留**。
  - `attempt`：PK；FK `run_id`→run ON DELETE CASCADE；索引 `idx_attempt_run(run_id, started_at)`。
  - `run_ops_event`：`seq` AUTOINCREMENT；`payload` default `'{}'`；索引 `idx_run_ops_event_run(run_id, seq)`、`idx_run_ops_event_trace(trace_id, seq)`、`idx_run_ops_event_kind(kind, ts DESC)`（**DESC**）。
  - `run_origin`：PK `run_id`；多列 NOT NULL + default（surface `'web'`、from_status `''`、origin_kind `'manual'`）；issue_id 可空；唯一索引 `idx_run_origin_idem(idempotency_key)`、普通 `idx_run_origin_trace`、`idx_run_origin_issue`。
  - `runner_health`：PK `agent_id`，多默认值列。
  - `event_log`：`seq` AUTOINCREMENT；索引 `idx_event_log_run(run_id, seq)`、`idx_event_log_thread(thread_id, seq)`。
  - `surface_health`：复合主键 `(agent_id, surface)`；`payload` default `'{}'`。
  - `issue_event`：`seq` AUTOINCREMENT；索引 `idx_issue_event_issue(issue_id, seq)`。

- [ ] **Step 2:** typecheck 通过。
- [ ] **Step 3: Commit** `feat(backend): drizzle schema for events.db`

### Task 2.2: events drizzle.config + baseline + runner

**Files:**
- Create: `apps/backend/drizzle.events.config.ts`, `apps/backend/drizzle/events/`
- Modify: `apps/backend/src/features/run/events-db-migrations.ts`（删手写数组，改 drizzle migrate 入口）

- [ ] **Step 1:** generate baseline，脚本 + 人工 diff vs 现状（尤其 DESC 索引、复合 PK、唯一索引）。
- [ ] **Step 2:** `runEventsDbMigrations()` 改为 drizzle `migrate(eventsDb, { migrationsFolder: "drizzle/events" })`，删除 `EVENTS_DB_MIGRATIONS` 数组。
- [ ] **Step 3:** typecheck + 空库启动建表。
- [ ] **Step 4: Commit** `refactor(backend): drizzle-kit baseline + migrate for events.db`

---

## Part 3 — feature adapter SQL → drizzle 重写（逐 feature）

> 每个 feature 一个 Task，逐 feature commit + 跑测试。重写后行为必须等价（同样的返回形状、排序、空值处理）。保留手写的语句按点名清单处理，并在代码注释写明保留原因。

### Task 3.1: project (backend.db)
- File: `apps/backend/src/features/project/adapter-sqlite.ts`
- [ ] CRUD + COUNT 聚合 → drizzle（`db.select({ c: count() })`）。唯一名约束依赖 `idx_project_name`。
- [ ] 补最小冒烟测试（如无现有测试）
- [ ] Commit `refactor(project): drizzle adapter`

### Task 3.2: issue (backend.db)
- File: `apps/backend/src/features/issue/adapter-sqlite.ts`
- [ ] CRUD + CAS UPDATE → drizzle；`SELECT changes()` → `.run().changes`。
- [ ] 补最小冒烟测试（如无现有测试）
- [ ] Commit `refactor(issue): drizzle adapter`

### Task 3.3: column-config (backend.db)
- File: `apps/backend/src/features/column-config/adapter-sqlite.ts`
- [ ] CRUD → drizzle；CASE-WHEN 排序用 `sql\`\`` 片段（注释保留原因）。唯一复合约束依赖 `idx_column_config_proj_status`。
- [ ] 补最小冒烟测试（如无现有测试）
- [ ] Commit `refactor(column-config): drizzle adapter`

### Task 3.4: deliverable (backend.db)
- File: `apps/backend/src/features/deliverable/adapter-sqlite.ts`
- [ ] CRUD → drizzle；UPSERT 走 `onConflictDoUpdate`/`onConflictDoNothing`；部分唯一索引 `idx_deliverable_run_kind` 用 `.onConflictDoUpdate({ target, targetWhere, set })`；`SELECT changes()` → `.run()`。
- [ ] 补最小冒烟测试（如无现有测试）
- [ ] Commit `refactor(deliverable): drizzle adapter`

### Task 3.5: conversation (backend.db)
- Files: `conversation/adapter-sqlite.ts`, `conversation/conv-svc-factory.ts`
- [ ] 17 条 CRUD → drizzle；纯翻译，不优化 N+1；删 threads LIKE 前缀残留。
- [ ] Commit `refactor(conversation): drizzle adapter`

### Task 3.6: agent (backend.db)
- Files: `agent/adapter-sqlite.ts`, `agent/agent-svc-factory.ts`
- [ ] CRUD/UPSERT → drizzle；派生列 `cid||':'||mid` 用 `sql\`\``；`assertNoActiveRun` 忙检测保留手写 + 注释；`purgeEvents` 可 drizzle subquery 或保留；`PRAGMA foreign_keys` 保留。
- [ ] 删除 `adapter-sqlite.ts:191-192` 两条死 DELETE（`checkpoint_interrupts`/`checkpoint_events`）
- [ ] Commit `refactor(agent): drizzle adapter, remove dead checkpoint DELETEs`

### Task 3.7: thread-projection (backend.db)
- File: `thread-projection/adapter-sqlite.ts`
- [ ] **关键：** 手写 `BEGIN IMMEDIATE` 写锁事务保留语义——现状已是显式 `db.run("BEGIN IMMEDIATE")`，不可降级为 drizzle 默认事务（默认 DEFERRED）。读/写本体可 drizzle 化，但事务边界保留底层 IMMEDIATE。加注释说明。
- [ ] Commit `refactor(thread-projection): drizzle adapter, keep IMMEDIATE lock`

### Task 3.8: run service/supervisor (events.db)
- Files: `run/service.ts`, `run/supervisor.ts`, `run/dispatcher.ts`（如有 SQL）
- [ ] service 2 条简单 → drizzle；supervisor CRUD → drizzle；`#reapStaleRuns`/`rediscover` 的 attempt⨝run JOIN → drizzle `.innerJoin()`；`db.transaction` CAS → drizzle 事务。
- [ ] Commit `refactor(run): drizzle service + supervisor`

### Task 3.9: runtime-ops (events.db)
- Files: `runtime-ops/store.ts`, `runtime-ops/service.ts`
- [ ] store 19 条多数 → drizzle；`last_insert_rowid()` → `.run().lastInsertRowid`；动态 IN → `inArray()`。
- [ ] service：`listRuns` 动态过滤 + LIKE ESCAPE + 动态 LIMIT **保留手写 `sql\`\`` + 注释**（风险项）；`json_extract` **保留 `sql\`\``**。
- [ ] Commit `refactor(runtime-ops): drizzle store + service`

### Task 3.10: event-log (events.db)
- File: `event-log/index.ts`
- [ ] DDL 已由 drizzle-kit 接管（Part 2），删本文件内建表；read 的动态 WHERE+LIMIT → drizzle（LIMIT 参数化）。
- [ ] Commit `refactor(event-log): drizzle queries`

### Task 3.11: main.ts wiring (events.db + backend.db)
- File: `apps/backend/src/main.ts`
- [ ] 2 条简单 SELECT → drizzle；保留 events.db PRAGMA 初始化。
- [ ] Commit `refactor(backend): drizzle in main wiring`

---

## Part 4 — framework checkpointer（完全独立）

### Task 4.1: checkpointer schema + drizzle 配置 + baseline

**Files:**
- Create: `packages/framework/drizzle.config.ts`
- Create: `packages/framework/drizzle/`（迁移输出目录）
- Create: `packages/framework/src/checkpointers/schema.ts`

- [ ] **Step 1:** 定义 3 表 schema：`checkpoint_messages`（PK `thread_id`）、`checkpoint_interrupts`（PK `thread_id`）、`checkpoint_events`（id AUTOINC PK, `idx_checkpoint_events_thread(thread_id, id)`）。
- [ ] **Step 2:** `drizzle.config.ts` 指向 `schema.ts` + `out: ./drizzle`。
- [ ] **Step 3:** generate baseline，脚本 + 人工 diff vs 现状。
- [ ] **Step 4: Commit** `feat(framework): drizzle schema + baseline for checkpointer.sqlite`

### Task 4.2: checkpointer 重写

**File:** `packages/framework/src/checkpointers/sqlite-checkpointer.ts`

- [ ] **Step 1:** 删除 `SQLITE_CHECKPOINTER_MIGRATIONS` + `runMigrations()` + 自建 `_migrations` 账本（迁移由 drizzle-kit 接管）。
- [ ] **Step 2:** 删除 `tablePrefix` 选项 + `table()` 帮助函数 + throw 死代码。固定表名。
- [ ] **Step 3:** save/load/saveInterrupt/appendEvent/readEvents → drizzle query。
- [ ] **Step 4:** `consumeInterrupt` 读后删用 drizzle `db.transaction()` 包成原子操作（顺手修并发重复消费 bug）。补最小测试守护。
- [ ] **Step 5:** typecheck + framework 测试通过。
- [ ] **Step 6: Commit** `refactor(framework): drizzle checkpointer, fix consumeInterrupt atomicity, drop dead tablePrefix`

---

## Part 5 — lark-bot bindings.db

### Task 5.1: bindings schema + config + baseline

**Files:**
- Create: `apps/lark-bot/src/db/schema.ts`, `apps/lark-bot/drizzle.config.ts`, `apps/lark-bot/drizzle/`

- [ ] **Step 1:** 定义 5 表。`run_stream` 含全部 16 列（以 `ensureSchema` CREATE 最终列为准），`message_delivery` 含复合唯一约束 `(conv_id, msg_id, chat_id)`。
- [ ] **Step 2:** generate baseline，脚本 + 人工 diff（特别确认 run_stream 16 列全部进 baseline）。
- [ ] **Step 3: Commit** `feat(lark-bot): drizzle schema + baseline for bindings.db`

### Task 5.2: bindings 重写

**File:** `apps/lark-bot/src/bindings-sqlite.ts`
- [ ] 删 `ensureSchema()` DDL + `migrateRunStreamSchema()` + `PRAGMA table_info`/`ALTER` 手写迁移（drizzle-kit 接管）。
- [ ] 19 条 CRUD/UPSERT → drizzle（`INSERT OR REPLACE`→`onConflictDoUpdate`、`INSERT OR IGNORE`→`onConflictDoNothing`、ON CONFLICT UPSERT→`onConflictDoUpdate`，动态 `updateRunStream` → `.set(partial)`）。
- [ ] 保留 zod row 校验；连接初始化保留 PRAGMA。
- [ ] Commit `refactor(lark-bot): drizzle bindings adapter`

---

## Part 6 — 收尾、清理、验证

### Task 6.1: 删除残留手写迁移基建

- [ ] 确认 `migrations.ts`/`events-db-migrations.ts`/checkpointer ledger/lark-bot ensureSchema 全部删净，无悬挂导出/引用（`git grep ALL_MIGRATIONS\|BACKEND_MIGRATIONS\|EVENTS_DB_MIGRATIONS\|SQLITE_CHECKPOINTER_MIGRATIONS` 应为空）。
- [ ] 修补遗留缺陷：`apps/web/src/lib/api.ts` 的 `createProject` body 类型补 `autoOrchestrate?: boolean`（ProjectForm 已在传）。
- [ ] Commit `chore(backend): remove hand-written migration ledgers`

### Task 6.2: 全量验证

- [ ] `bun run typecheck`（全 workspace）通过。
- [ ] `bun run lint`（biome + eslint）通过。
- [ ] `bun test`（全 workspace）通过。
- [ ] 对全新空库执行 backend + lark-bot 启动，确认四套 baseline 全部建表成功，应用读写正常。
- [ ] `bunx drizzle-kit check --config <各 config>` 无 drift。

### Task 6.3: package.json 脚本

- [ ] 在 backend/lark-bot/framework 加 `db:generate` / `db:migrate` / `db:check` 脚本（带 `--config`），文档化多库用法。
- [ ] Commit `chore: drizzle db scripts`

### Task 6.4: retro

- [ ] 写 `docs/superpowers/retros/2026-06-23-m20-drizzle-orm-migration.md`：保留手写清单的最终决定、baseline diff 中发现的 schema 偏差、checkpointer 独立化的取舍、consumeInterrupt 原子化修复。

---

## 风险与回归点（实施者必须逐条核对）

1. **baseline ≠ 现状** 是最大风险：drizzle-kit 生成的 SQL 必须与现状逐列逐索引一致，尤其 **复合主键列顺序、部分索引 WHERE、唯一性、索引排序方向 DESC、各列 DEFAULT 值**。每个 baseline 都要脚本 + 人工双保险，不可信任「跑得起来」。
2. **四库不可混账本**：backend.db / events.db / checkpointer.sqlite / bindings.sqlite 各自独立 drizzle 迁移目录与 `__drizzle_migrations__`。checkpointer 已确认完全独立，不并入 backend baseline。
3. **`BEGIN IMMEDIATE` 锁不可降级**（thread-projection）：现状已是显式 `db.run("BEGIN IMMEDIATE")`，不可改为 drizzle 默认事务（默认 DEFERRED）。
4. **`changes()` / `last_insert_rowid()`** 必须改用 drizzle `.run()` 返回值，散落多处易漏。
5. **JSON 函数 / LIKE ESCAPE / 动态过滤**（runtime-ops）优先保留手写 `sql\`\``，避免语义偏差。
6. **run_stream 的 16 列**（lark-bot）必须全部进 baseline，否则字段丢失。
7. **行为等价**：每个 adapter 重写后返回形状、排序、空值、UPSERT 冲突目标必须与原 SQL 完全一致——靠 feature 测试守护，无测试的路径需补最小用例。
8. **agent archive 死代码**：`adapter-sqlite.ts:191-192` 两条 checkpoint DELETE 必须删（backend.db 不再建这两表）。
