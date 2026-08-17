# Harness SessionManager 上提 Implementation Plan

> **Spec:** `docs/superpowers/specs/2026-07-09-harness-session-manager-lift.md`

---

## 代码事实

| 事实 | 位置 |
|------|------|
| `SessionManager` 接口 + `SqliteSessionManager` | `apps/backend/src/features/span/session-manager.ts` (85行) |
| 构造依赖 `BackendConfig` (dataDir) + `SpanSupervisor` (startSpan) | 同上 line 38-41 |
| `ulid` from `../../infra/ids.js` | 同上 line 5 |
| `sqliteCheckpointer` from `@chengchenccc/framework` | 同上 line 2 |
| `AgentSession`, `SessionConfig` from `@chengchenccc/harness` | 同上 line 3 |
| harness barrel | `packages/harness/src/index.ts` |
| `AgentSessionConfig.startSpan` 签名 | `packages/harness/src/agent-session.ts:43` |
| main.ts 构造 SessionManager | `apps/backend/src/main.ts:107` |
| import SessionManager 的文件 | conversation-compose.ts, scheduler.ts, loop-step.ts, loop/http.ts, span/http.ts |
| `RunSpan` type from framework | `packages/framework/src/trace.ts` |

---

## Task 1: harness 新增 session-manager.ts

**Files:**
- Create: `packages/harness/src/session-manager.ts`
- Modify: `packages/harness/src/index.ts`

- [ ] **Step 1: 创建 session-manager.ts**

从 backend 的 session-manager.ts 移入，改动：
1. 删除 `import type { BackendConfig }`、`import type { SpanSupervisor }`、`import { ulid }`
2. `ulid()` 替换为 `crypto.randomUUID()`
3. 构造参数改为 `SessionManagerConfig { checkpointerPath: string; startSpan?: StartSpanFn }`
4. `this.#config.dataDir` 改为 `this.#config.checkpointerPath`
5. `this.#supervisor.startSpan(...)` 改为 `this.#config.startSpan?.(...)`
6. 定义 `StartSpanFn` 类型（复用 AgentSessionConfig.startSpan 签名）
7. `sqliteCheckpointer({ db: join(this.#config.dataDir, "checkpointer.db") })` 改为 `sqliteCheckpointer({ db: this.#config.checkpointerPath })`

- [ ] **Step 2: 更新 index.ts barrel**

新增导出 `SessionManager`、`SqliteSessionManager`、`SessionManagerConfig`、`StartSpanFn`

- [ ] **Step 3: build harness + typecheck**

`cd packages/harness && bun run build && bun run typecheck`

- [ ] **Step 4: Commit**

---

## Task 2: backend 改 import + 构造参数

**Files:**
- Delete: `apps/backend/src/features/span/session-manager.ts`
- Modify: `apps/backend/src/main.ts`
- Modify: `apps/backend/src/features/conversation/conversation-compose.ts`
- Modify: `apps/backend/src/features/cron/scheduler.ts`
- Modify: `apps/backend/src/features/loop/loop-step.ts`
- Modify: `apps/backend/src/features/loop/http.ts`
- Modify: `apps/backend/src/features/span/http.ts`

- [ ] **Step 1: 删除 backend/session-manager.ts**

- [ ] **Step 2: main.ts 改构造**

```typescript
// 旧: import { SqliteSessionManager } from "./features/span/session-manager.js";
// 新: import { SqliteSessionManager } from "@chengchenccc/harness";

// 旧: const sessionManager = new SqliteSessionManager({ config, supervisor });
// 新:
const sessionManager = new SqliteSessionManager({
  checkpointerPath: join(config.dataDir, "checkpointer.db"),
  startSpan: (sid, sid2, opts) => supervisor.startSpan(sid, sid2, opts),
});
```

需要 `import { join } from "node:path"` (main.ts 已有)。

- [ ] **Step 3: 5 个文件改 import**

所有 `import type { SessionManager } from "./span/session-manager.js"` (或相对路径变体) 改为 `import type { SessionManager } from "@chengchenccc/harness"`。

逐文件：
- conversation-compose.ts: `import type { SessionManager } from "../span/session-manager.js"` -> `import type { SessionManager } from "@chengchenccc/harness"`
- scheduler.ts: 同上模式
- loop-step.ts: 同上
- loop/http.ts: 同上
- span/http.ts: `import type { SessionManager } from "./session-manager.js"` -> `import type { SessionManager } from "@chengchenccc/harness"`

- [ ] **Step 4: typecheck + test**

`cd apps/backend && bun run typecheck && bun test`

- [ ] **Step 5: Commit**

---

## Task 3: 最终验证

- [ ] `cd packages/harness && bun test`
- [ ] `cd apps/backend && bun test`
- [ ] `bun run typecheck` (全量 37/37)
- [ ] `npx biome check .`
- [ ] Commit + push
