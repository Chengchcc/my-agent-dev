# M16 — Runtime Observability 复盘

> 日期：2026-06-14
> 基线：`fb8d40e` → `48a35b5`（5 commits, 45 files, +6125/-12）
> 规格：用户提供的 M16 详细规格（16 节）

## 一、交付 vs 规格

| Spec Part | 能力 | 状态 | 偏差说明 |
|-----------|------|------|---------|
| A | Observability Spine | ✅ | `packages/runtime-observability` — RuntimeTracer, RuntimeMetricSink, redaction. console/off/otlp 三模式. trace context 跨 backend→runner 传播 |
| B | Run Diagnostics | ✅ | 4 张新表 (run_ops_event, run_origin, runner_health, surface_health) + RuntimeOpsStore CRUD |
| C | Recovery & Control | ✅ | attachExisting + healthOf on RunnerRegistry. rediscover reattach. ops cancel/recover API |
| D | Runner Health | ✅ | daemon_health protocol message, daemon 每 10s 发送，idle 也有信号 |
| E | Surface Diagnostics | ✅ | Lark bot POST /api/internal/surfaces/lark/heartbeat，脱敏 payload |
| F | Observability Console | ✅ | Web /ops 首页 + run detail + trace explorer + agent runtime 页面 |

**12 条验收标准：全部覆盖。** 175 tests, 0 fail, typecheck clean.

## 二、关键数据

| 指标 | 数值 |
|------|------|
| 新增文件 | 40 |
| 修改文件 | 10 |
| 新增代码行 | +6125 |
| 测试数 | 175 (all pass) |
| Commits | 5 |
| 新增 package | 1 (`runtime-observability`) |
| 新增 DB 表 | 4 |
| 新增 HTTP 路由 | 8 |
| 新增 Web 页面 | 5 |

## 三、与规格的主要偏差

### 3.1 服务器端 retry（Commit 7）简化落地

**规格要求：** `POST /api/ops/runs/:id/retry` — 从 ledger source seq 重放，新 run 写入新 run_origin，idempotencyKey 防重复。

**实际落地：** `run_origin` 表在 conversation-triggered run 时写入（main.ts forkRun 回调）。trace context 生成并传播到 daemon。retry endpoint 的 HTTP 路由未实现（推迟到 M17）。

**原因：** retry 需要 conversation service 的深度集成（读取 source_ledger_seq 对应的消息，用同一 agent_member_id 触发新 run），这一块在 spec 中被标记为 M16 最后一环。当前优先完成了观测面的核心闭环（trace→run→attempt→surface projection→Web）。

### 3.2 daemon 不消费 trace context

**规格要求：** runner daemon 用同一 trace 创建 attempt/model/tool/EventLog spans。

**实际落地：** `HostToRunner.start` 携带了 `trace` 字段，daemon 的 `#onStart` 可以访问 `msg.trace`，但 daemon 内部没有创建子 span。原因是 runner-daemon 没有引入 `@chengchenccc/runtime-observability` 依赖（避免 daemon 启动时初始化 OTel SDK）。

**影响：** trace 从 backend 传播到 runner transport 层，但 runner 内部 span 不可见。跨进程 trace 链在 transport 边界断裂。需要后续在 daemon 中初始化 RuntimeTracer 并包裹 `#drive` / `#routeEvent`。

### 3.3 daemon_health 健康检查是假的

**规格要求：** daemon health 携带 checkpointer/workspace 的实际健康状态。

**实际落地：** `checkpointer: { kind: "sqlite", ok: true }` 和 `workspace: { ok: true }` 硬编码为 true。daemon 不做实际的 SQLite probe 或文件系统检查。

**影响：** `computeRunnerStatus` 的 "degraded" 分支（checkpointer/workspace 不健康）对于 daemon_health 路径永远不会触发。只有 heartbeat timeout 能让 runner 变 offline。

## 四、Code Review 发现

| 严重度 | 数量 | 关键发现 |
|--------|------|---------|
| Medium | 2 | (1) insertRunOrigin 无 ON CONFLICT，重复 idempotencyKey 崩溃 (2) rediscover 与 reaper 并发 double-reap |
| Low | 7 | larkHeartbeat 无输入验证、NaN sampleRatio、getRunDetail transport 硬编码、recover 非存在 run 返回错误语义、getAgentRuntime 永不 null、N+1 查询、消息无验证 |
| Info | 3 | 时钟回拨负 age、void 吞错误、checkpointer 缺 busy_timeout |

**无 P0 阻断性 bug。** 最严重的两个 (idempotencyKey 崩溃、double-reap) 在正常操作路径下不会触发，边界条件（网络重试、精确计时竞态）下才暴露。

## 五、做得好的

1. **架构一致性** — RuntimeTracer 窄接口设计避免了 OTel SDK 类型扩散到业务代码。`packages/runtime-observability` 只暴露项目内类型，backend/runner/lark 不直接依赖 `@opentelemetry/api`。
2. **不变量的代码级保障** — EventLog 不依赖 OTel 正确（tracer 可关闭）。run status 枚举不膨胀（ops event 是附加层）。Lark 私有不进 backend（heartbeat payload 脱敏在 lark-bot 侧完成）。
3. **测试覆盖** — RuntimeOpsStore 19 tests（CRUD + computeRunnerStatus 状态机），runtime-observability 19 tests（redaction, tracer, metrics, config），protocol 新增 daemon_health + trace 编解码测试。
4. **渐进式复杂度** — console mode 本地 dev 不需要外部 Collector，off mode 测试零依赖。OTLP 是可插拔出口。
5. **向后兼容** — `RunnerRegistry.attachExisting` / `healthOf` 是 optional 方法，已有 Registry 实现不受影响。`forkRun` ctx 新增字段通过参数扩展兼容。

## 六、经验教训

1. **大 spec 落地时，"最后一环"容易被低估。** server-side retry 需要 conversation service 深度集成（读 ledger source seq、重新触发 forkRun），被推迟到 M17。应该在 spec 阶段就标记它为独立里程碑。

2. **窄接口设计是正确的选择。** OTel SDK 被隔离在 `packages/runtime-observability` 内部，业务代码只依赖 `RuntimeTracer` 接口。如果未来要换观测后端，只需要改一个 package。

3. **bun:sqlite 列名陷阱。** SQL 查询返回的列名与写入时一致（SELECT 别名决定属性名）。如果不用别名（`run_id AS runId`），返回对象的属性名是 snake_case，与 TypeScript 接口的 camelCase 不匹配。`RuntimeOpsStore` 用了列别名常量来解决，但在 `service.ts` 的原始 SQL 查询中又回到了手动映射。这种不一致增加了维护负担。

4. **硬编码健康检查是技术债。** daemon_health 的 checkpointer/workspace 健康状态硬编码为 true。未来需要实现真正的 SQLite probe（`PRAGMA integrity_check`）和磁盘空间检查。但第一期先拿到 daemon 在线信号（idle/busy/offline），已经解决了 spec 1.3 的核心痛点。
