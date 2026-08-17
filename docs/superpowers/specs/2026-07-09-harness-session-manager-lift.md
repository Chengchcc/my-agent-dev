# Spec: Harness 层增厚 -- SessionManager 上提

> 状态：待评审
> 关联：设计哲学"暴露业务，隐藏机制"
> 审查结论：APPROVED_WITH_CONCERNS（ArchReview3）

## 1. 目标

把 SessionManager 从 backend 上提到 harness 层，让 harness 成为自包含的 Agent 运行时。backend 变薄为业务翻译层。未来 CLI 可直接用 harness + plugins 搭积木，不依赖 backend。

## 2. 改动范围

### 2.1 harness 新增

**文件：`packages/harness/src/session-manager.ts`**

从 `apps/backend/src/features/span/session-manager.ts` 移入，改动：

1. `SessionManager` 接口不变（`create` / `open` / `get` / `dispose`）
2. `SqliteSessionManager` 构造参数改为接口注入：

```typescript
export type StartSpanFn = (
  spanId: string,
  sessionId: string,
  opts?: unknown,
) => Promise<RunSpan> | RunSpan;

export interface SessionManagerConfig {
  /** checkpointer DB 路径（如 dataDir + "checkpointer.db"） */
  checkpointerPath: string;
  /** 可选的 span 追踪回调（backend 注入 supervisor.startSpan） */
  startSpan?: StartSpanFn;
}

export class SqliteSessionManager implements SessionManager {
  constructor(config: SessionManagerConfig) { ... }
}
```

3. `ulid` 替换为 `crypto.randomUUID()`（去 backend `infra/ids.js` 依赖）
4. `sqliteCheckpointer` 已从 `@chengchenccc/framework` 导入（harness 已依赖 framework）
5. `BackendConfig` 依赖消除，`SpanSupervisor` 依赖消除

**文件：`packages/harness/src/index.ts`**

新增导出：
```typescript
export type { SessionManager, SessionManagerConfig, StartSpanFn } from "./session-manager.js";
export { SqliteSessionManager } from "./session-manager.js";
```

### 2.2 backend 改动（机械改 import）

| 文件 | 改动 |
|------|------|
| `apps/backend/src/features/span/session-manager.ts` | **删除** |
| `apps/backend/src/main.ts` | `SqliteSessionManager` import 从 `./features/span/session-manager.js` 改为 `@chengchenccc/harness`；构造改为 `new SqliteSessionManager({ checkpointerPath: join(config.dataDir, "checkpointer.db"), startSpan: (s, s2, o) => supervisor.startSpan(s, s2, o) })` |
| `apps/backend/src/features/conversation/conversation-compose.ts` | `SessionManager` type import 改为 `@chengchenccc/harness` |
| `apps/backend/src/features/cron/scheduler.ts` | 同上 |
| `apps/backend/src/features/loop/loop-step.ts` | 同上 |
| `apps/backend/src/features/loop/http.ts` | 同上 |
| `apps/backend/src/features/span/http.ts` | 同上 |
| `apps/backend/src/features/skill-pack/install-session.ts` | 不改（直接 `new AgentSession()`，不走 SessionManager） |

### 2.3 不改动的

- `agent-helpers.ts` 留在 backend（ModelFactory 接口是阶段 2）
- `conversation-compose.ts` 业务逻辑不变（只改 import 路径）
- `SpanSupervisor` 留在 backend
- `Plugin` 接口不变（阶段 3）
- 现有 plugin 包不变

## 3. 依赖关系

```
改造前:
  harness → framework → core
  backend → harness + framework + adapter-anthropic + adapter-mcp + ...
  backend/span/session-manager.ts → harness (AgentSession) + framework (sqliteCheckpointer) + backend (BackendConfig, SpanSupervisor, ulid)

改造后:
  harness → framework → core
  harness/session-manager.ts → framework (sqliteCheckpointer) + harness (AgentSession)
  backend → harness (SessionManager) + framework + ...
```

**harness 不反向依赖 backend。** SessionManager 的所有外部依赖通过接口注入。

## 4. 验收标准

1. `packages/harness/src/session-manager.ts` 存在，导出 `SessionManager`、`SqliteSessionManager`、`SessionManagerConfig`、`StartSpanFn`
2. `packages/harness/src/index.ts` 导出上述类型
3. `apps/backend/src/features/span/session-manager.ts` 已删除
4. backend 6 个文件的 import 改为 `@chengchenccc/harness`
5. `main.ts` 构造 `SqliteSessionManager` 使用新参数（`checkpointerPath` + `startSpan`）
6. `SqliteSessionManager` 不依赖 `BackendConfig` 或 `SpanSupervisor`
7. `bun run typecheck` 37/37 通过
8. `cd apps/backend && bun test` 全量通过
9. `cd packages/harness && bun test` 全量通过

## 5. 不做的事

- 不做 ModelFactory/ToolFactory 接口（阶段 2）
- 不做 Plugin init/commands 扩展（阶段 3）
- 不做 spawn_subtask 工具（阶段 3）
- 不做 conversation plugin 提取（不做）
- 不做 Pi 的 jiti 热加载（用编译期 import）
- 不做 package.json mat 字段声明（workspace 包已足够）
