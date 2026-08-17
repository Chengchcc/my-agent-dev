# M9 Spec — Durable Runs（长任务执行与 SSE 投影解耦 + EventLog 落地）

> M9 把 M8 的 **run 执行**从"绑死在 HTTP SSE 流上的进程内 generator"重构为**独立子进程执行 + 事件落 EventLog + SSE 只读投影**的可靠形态。
>
> 核心目标:数小时级长任务在**客户端断连后继续跑完**;**断线重连不丢事件**(`Last-Event-ID` 续读);**backend 重启后重新发现仍存活的 run 子进程并接管事件流**;**用户 cancel 几秒内真正中止**(AbortSignal 透传到模型 fetch)。
>
> 同时清偿 M8 遗留的两类前置债务:统一 SQLite 迁移台账(修当前红的 `db.test`),以及补齐 **context 裁剪保 tool 对 / Anthropic role 交替** 两项影响长会话正确性的必修项。
>
> 这是**架构落地题**。所有概念已在架构文档定型——本 spec 以架构文档为准,**不复用** spec 早期草稿里的 `checkpoint_events` 口径:
> [00-vision](../architecture/00-vision.md) · [13-event-log](../architecture/13-event-log.md) · [11-backend](../architecture/11-backend.md) · [12-agent-spec](../architecture/12-agent-spec.md) · [04-checkpointer](../architecture/04-checkpointer.md)

---

## 一、定位

M9 是 **一个新 port 包 + backend 子进程化 + 事件投影端点 + 实体重建模 + 清理积压**：

- 新增 `@chengchenccc/event-log` — `EventLog` port 接口定义(`EventSink` 写侧 / `EventSource` 读侧)+ sqlite/in-memory 实现。事件事实源,独立于 checkpointer
- 改 `apps/backend` — `RunService.start` 从"返回进程内 generator"改为"**fork runner-stdio 子进程 + 返回 202 + runId**";新增 `RunSupervisor`(进程内)、`GET /api/runs/:id/events` SSE 投影端点、重启重新发现逻辑
- 改 `@chengchenccc/runner-stdio` — entry 自持 `EventSink`,每个 yield 出来的事件 `append` 落库;捕获 `SIGTERM` 透传 abort;支持 `mode='resume'`
- 改 `@chengchenccc/agent-spec` — 新增 `runId` / `attemptId` / `mode` / `resumeCommand` / `storage.eventLog` 字段(EventLog 连接配置由 backend 下发;`attemptId` 用于子进程 heartbeat 定位)
- 改 `@chengchenccc/adapter-anthropic` — 把 `AbortSignal` 透传给底层 `fetch({ signal })`,使 in-flight 模型调用可即时取消
- 改 `@chengchenccc/checkpointer-sqlite` — 表创建唯一归口到 backend 迁移台账,清偿 `db.test` 红;`appendEvent`/`readEvents`(Tier 3)语义降级为内部审计,不再是投影源
- 实体重建模:`runs` 单表拆为 **`run`(逻辑)** + **`attempt`(物理执行)** 两表;存活判定收敛到 **`heartbeat_at` 单一真相源**
- 改 `apps/cli` — 从"POST 拿流"改为"POST 拿 runId → GET events 订阅"

**M9 显式不做**：

- **不做分布式 / 多机调度** — 单 backend 实例 + 单 SQLite 文件;多机 fan-out 留后续
- **不做 run 优先级队列** — 全局并发超限直接 429,不排队(队列状态机不在 M9)
- **不做事件 TTL / 清理** — 本期 `event_log` 永久留存,清理策略留后续配置项
- **不切 PostgreSQL** — `EventLog` port 接口为 PG 留口子(LISTEN/NOTIFY),M9 只交付 sqlite 实现(纯轮询 tail)
- **不做 WebSocket** — 继续 SSE
- **不做纯 event-sourced resume** — checkpointer 仍是 resume 的唯一权威源(它存裁剪后输入态);EventLog 不承担 resume(见 [13-event-log §5.1](../architecture/13-event-log.md))
- **不做 EventLog HTTP/RPC 子服务化** — sandbox 未启用前,子进程与 backend 直接 open 同一 sqlite 文件;HTTP 化是 future work
- **不做孤儿子进程外部 supervisor** — M9 只让子进程在 `cancelGraceMs×N` 无人 cancel 时自我了断,外部回收留后续

---

## 二、架构总览

> 与架构文档对齐([13-event-log](../architecture/13-event-log.md) 为准):事件事实源是**独立的 `EventLog` port**(独立 `event_log` 表,带 `thread_id` + `run_id`),**不复用** checkpointer 的 `checkpoint_events`。子进程持有写侧 `EventSink`(只能 `append`),backend 投影端持有读侧 `EventSource`(只能 `read`/`subscribe`)。Checkpointer 退守为 resume 的唯一权威源。

### 2.1 三权分立(执行 / 事实源 / 投影)

```
   执行者(短命)              事实源(永久)              投影者(随连接)
┌──────────────────┐      ┌───────────────────┐      ┌──────────────────┐
│ runner-stdio 子进程│      │   EventLog (DB)   │      │ backend SSE 投影端 │
│  agent loop       │      │   event_log 表    │      │  GET /runs/:id/    │
│                   │      │  ┌─────────────┐  │      │      events       │
│  EventSink        │─append─►│seq,thread_id│  │      │                  │
│  (只能 append)    │      │  │run_id,event │◄─subscribe─ EventSource     │
│                   │      │  └─────────────┘  │      │  (只能 read/sub) │
│ heartbeat_at↑ ────┼──────►│  run / attempt   │      │                  │
└──────────────────┘      └───────────────────┘      └──────────────────┘
        │  stdout NDJSON(可选低延迟通知,断了不丢事件)        ▲
        └────────────────────────────────────────────────────┘
                   RunSupervisor(进程内 pub/sub + 轮询兜底)
```

铁律(沿用 [13-event-log §二](../architecture/13-event-log.md)):**执行者只向最持久层(DB)写,绝不依赖 backend 转发**;**执行者与投影者互不认识,只通过 EventLog 通信**。客户端断连、backend 重启都不影响子进程继续 `append`。

### 2.2 HTTP 端点流转

```
POST /api/threads/:id/runs
        │  RunService.start
        ▼
  ① 写 run(逻辑)+ attempt(物理,含 pid/heartbeat_at)台账,status=running
  ② fork runner-stdio 子进程(独立 PID,经 AgentSpec 注入 EventSink 连接配置)
  ③ 立即返回 202 { runId }        ◄── 不再绑 SSE(破坏性变更,见 §六)

      子进程:每个 AgentEvent → sink.append(thread_id, run_id, ev) 落库
              定期 UPDATE attempt SET heartbeat_at = now()
              stdout 同步写 NDJSON(可选,仅作低延迟通知)

GET /api/runs/:id/events    (SSE 投影,可多次连 / 断 / 重连 / 冷读)
        │  Last-Event-ID: <seq>  →  afterSeq
        ▼
  EventSource.subscribe({ runId, afterSeq })
        │  ① 回放 seq > afterSeq 的历史事件
        │  ② tail 新事件:pub/sub 实时推 + 轮询兜底(每 pollMs 查 seq > 高水位)
        ▼
  text/event-stream,每帧 id: <event_log.seq>;run 终态后合成 event: done

POST /api/runs/:id/cancel
        │  AbortController.abort() → 子进程 SIGTERM
        ▼
  子进程 entry 捕获 → agent loop signal → adapter fetch({ signal }) 即时取消
  超时兜底:cancelGraceMs 后 SIGKILL,attempt.status=aborted
```

关键:`POST /runs` 由"返回 SSE 流"改为"**返回 202 + runId**";事件改由独立的 `GET /runs/:id/events` 投影端点消费。这是对 M8 的**破坏性 API 变更**(见 §六)。

### 2.3 关键流程时序

**(a) 启动 + 投影(正常路径)**

```
Client      Backend            EventLog(DB)        Runner 子进程
  │ POST /runs  │                   │                   │
  │────────────►│ write run+attempt │                   │
  │             │──────────────────►│                   │
  │             │ fork ─────────────┼──────────────────►│ (EventSink 注入)
  │  202 {runId}│                   │                   │
  │◄────────────│                   │                   │
  │ GET /events │                   │                   │
  │────────────►│ subscribe(runId)  │                   │
  │             │──────────────────►│   append(evt) ◄───│ (agent loop)
  │  id:1 data… │◄─ tail ───────────│◄──────────────────│
  │◄────────────│                   │   append(evt) ◄───│
  │  id:2 data… │◄──────────────────│◄──────────────────│
  │  …          │                   │   (终态) ◄────────│ exit
  │ event: done │◄──────────────────│                   │
  │◄────────────│                   │                   │
```

**(b) 客户端断连 → 重连续读(不影响执行)**

```
Client      Backend            EventLog(DB)        Runner 子进程
  │  ✗ 断开    │ cancel 订阅        │   append 继续 ◄───│ (无感知,继续跑)
  │   (网络断) │ (不 abort run)    │◄──────────────────│
  │            │                   │   append 继续 ◄───│
  │ GET /events│                   │                   │
  │ Last-Event-ID: 5               │                   │
  │───────────►│ subscribe(afterSeq=5)                 │
  │            │──────────────────►│ 回放 seq>5 历史   │
  │ id:6 data… │◄──────────────────│                   │
  │◄───────────│   …               │   append ◄────────│
  │ 无重复无遗漏(投影端按 seq 去重 + 高水位)            │
```

**(c) backend 重启 → 重新发现(heartbeat 单一真相源)**

```
Backend(旧)   EventLog(DB)        Runner 子进程
  │  ✗ 崩溃     │   append 继续 ◄───│ (DB 是事实源,继续写)
              │   heartbeat_at↑ ◄─│
─────────────────────────────────────────
Backend(新)   │                   │
  │ 启动扫描 attempt status=running                    │
  │───────────►│ 读 heartbeat_at 新鲜度(废弃 kill(pid,0))
  │  ┌── 新鲜 → 认领该 run,subscribe(afterSeq=高水位) 补齐
  │  │        │◄── 后续事件经 DB 轮询投影,无需重连 stdout 管道
  │  └── 超时 → attempt.status=interrupted,发终态事件
```

**(d) cancel 真停**

```
Client → POST /cancel → Backend ── SIGTERM ──► Runner 子进程
                                                  │ entry 捕获 signal
                                                  │ agent loop 下个 await 点停
                                                  │ adapter fetch({signal}) 即时中断 in-flight 模型调用
                                                  │ 发终态 aborted 事件 → 干净退出
   cancelGraceMs 内未退出 ── SIGKILL ──► 强杀;attempt.status=aborted
```

**(e) resume(interrupt 后,backend re-fork 新 attempt)**

```
run(逻辑, 同 run_id 贯穿)
  attempt#1 ──interrupt──► 子进程退出,checkpointer 存 InterruptState
        │                  (checkpointer = resume 唯一权威源)
        ▼
  POST /runs/:id/resume → backend fork attempt#2(同 run_id, mode='resume')
        │                  新子进程经 checkpointer 重建裁剪后输入态 → 续跑
        ▼
  attempt#2 ──► append 事件仍带同一 run_id
        前端 GET /runs/:id/events 看到的是一条不断的流(跨子进程连续)
```

---

## 三、设计原则

沿用 M1–M8 不变,强化四条解耦铁律(源出 [13-event-log §二](../architecture/13-event-log.md)):

1. **依赖指向抽象,存储细节封死在 adapter** — framework / backend 只认 `EventLog` 接口;sqlite 轮询、PG 的 `LISTEN/NOTIFY`、seq 生成方式全部封死在各自 adapter。换存储 = 换 adapter,上层零改动。
2. **tail 是 EventLog 的读对偶,不是执行者的能力** — `subscribe` 是 `EventSource` 接口的一部分,谁想 tail 向 EventLog 要,不需要知道事件谁写、写在哪。
3. **执行者与投影者互不认识** — 子进程只调 `append`(`EventSink`),backend 只调 `read`/`subscribe`(`EventSource`),唯一通信媒介是 EventLog。
4. **执行者只向最持久层写,绝不依赖 backend 转发** — 子进程**直写 EventLog**,不走 "stdout → backend → EventLog" 转发链;stdout 仅作可选低延迟通知,断了不丢事件。这是 durable 性质的地基。

外加两条建模纪律(源出 [13-event-log §十](../architecture/13-event-log.md)):

- **一切真相沉到生命周期最长的层(DB)** — 短生命周期对象(SSE 连接、backend 进程、子进程)之间不直接耦合,只通过持久层派生/投影。
- **存活判定单一真相源** — 用 `heartbeat_at` 一列判活,**废弃 `kill(pid,0)`**(PID 跨重启不可靠,复用风险)。

---

## 四、交付范围

### 4.1 新包：`@chengchenccc/event-log`

**包路径**：`packages/event-log/`

**依赖**：`@chengchenccc/framework`(type-only：`AgentEvent`);零运行时依赖(`bun:sqlite` 是 Bun built-in)。

**导出**(接口定义见 [13-event-log §三](../architecture/13-event-log.md)):

```ts
// packages/event-log/src/index.ts
import type { AgentEvent } from "@chengchenccc/framework";

export interface EventRecord {
  seq: number;          // 全局单调,SSE Last-Event-ID 即此值
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

/** 写侧:事件生产者(run 子进程)。只能 append */
export interface EventSink {
  append(threadId: string, runId: string, event: AgentEvent): Promise<number>;
}

/** 读侧:事件投影者(backend SSE / 审计 / 回放)。只能读 */
export interface EventSource {
  read(query: ReadQuery): Promise<EventRecord[]>;
  subscribe(query: ReadQuery, opts?: SubscribeOptions, signal?: AbortSignal): AsyncIterable<EventRecord>;
}

export interface SubscribeOptions {
  pollMs?: number;  // 轮询间隔,默认 DEFAULT_POLL_MS=250
}

export const DEFAULT_POLL_MS = 250;

export interface EventLog extends EventSink, EventSource {}

export function sqliteEventLog(opts: { db: Database | string }): EventLog;
export function inMemoryEventLog(): EventLog;
export const EVENT_LOG_MIGRATIONS: readonly { name: string; id: number; up: string }[];
```

**sqlite 实现要点**:append-only + WAL + `busy_timeout`(支持子进程与 backend 并发写同库);`subscribe` = 回放 `seq > afterSeq` → 轮询 tail(默认 250ms,`seq > 高水位`);无 LISTEN/NOTIFY,纯轮询。

```sql
CREATE TABLE event_log (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  TEXT NOT NULL,
  run_id     TEXT NOT NULL,
  event      TEXT NOT NULL,   -- JSON
  ts         INTEGER NOT NULL
);
CREATE INDEX idx_event_log_run    ON event_log(run_id, seq);
CREATE INDEX idx_event_log_thread ON event_log(thread_id, seq);
```

### 4.2 改：`@chengchenccc/agent-spec`

新增字段(见 [12-agent-spec](../architecture/12-agent-spec.md)),`schemaVersion` 不变(向后兼容追加):

```ts
runId: z.string().min(1),                         // backend 下发,贯穿所有 attempt
attemptId: z.string().min(1),                      // backend 下发,本次物理执行的 ID(heartbeat 以此定位行)
mode: z.enum(["run", "resume"]).default("run"),
resumeCommand: z.object({                          // mode='resume' 时必填
  approved: z.boolean(),
  message: z.string().optional(),
}).optional(),
storage: z.object({
  eventLog: z.object({ kind: z.literal("sqlite"), path: z.string() }),       // backend 收敛下发
  checkpointer: z.object({ kind: z.enum(["sqlite", "memory"]), path: z.string().optional() }),
}),
```

> **不变量(EventLog 收敛)**:`storage.eventLog` 由 backend 下发并指向 backend 也能连的同一存储;`storage.checkpointer` 由 runner 策略自由选(backend 永久无感)。见 [13-event-log §8.2](../architecture/13-event-log.md)。

### 4.3 改：`@chengchenccc/runner-stdio`

entry 自持写侧 `EventSink`,`append` 在前、`writeEvent`(stdout 通知)在后;新增 `mode='resume'` 分支;捕获 `SIGTERM` 透传 abort。

```ts
const sink: EventSink = sqliteEventLog({ db: spec.storage.eventLog.path }); // 只取写侧
const stream = spec.mode === "resume"
  ? agent.resume(spec.resumeCommand, { signal, maxSteps: spec.maxSteps })
  : agent.run(spec.input, { signal, maxSteps: spec.maxSteps });
for await (const ev of stream) {
  await sink.append(spec.threadId, spec.runId, ev);   // 事实源(写侧只能 append)
  writeEvent(ev);                                     // 可选低延迟通知
}
```

heartbeat:entry 起一个定时器 `UPDATE attempt SET heartbeat_at = now()`(它本就连着 DB)。

### 4.4 改：`@chengchenccc/adapter-anthropic`

`anthropic-chat-model.ts` 把 `ChatModelOptions.signal` 透传给底层 `fetch({ signal })`,使 cancel 时 in-flight 模型调用即时中断,而非等响应回来。

### 4.5 改：`@chengchenccc/checkpointer-sqlite`(债务清偿)

- **表创建唯一归口** backend `openDb()` 台账循环;`sqliteCheckpointer()` 不再自建表,仅假设表已存在。harness 独立使用场景提供 `ensureCheckpointerSchema(db)` 显式调用,内部也走"按 name 台账"逻辑,不裸 `CREATE`。
- **`db.test` 红的真实根因**:backend 经 `"main": "./dist/index.js"` 导入 checkpointer 的**陈旧构建产物**(早于源码加 `name`/`id` 字段),迁移对象 `name` 为 `null` → 台账记 `null` → `checkpointer_v1_messages` 未登记。**修法**:rebuild dist + 归口台账,并加 CI 守卫防 dist 漂移。
- `appendEvent`/`readEvents`(Tier 3)语义降级为**内部审计**,**不再是 UX 投影数据源**(投影一律走 EventLog)。保留所有 11 处框架调用点不动(继续做内部审计),在 `Checkpointer` 接口的 `appendEvent?`/`readEvents?` 上加 `@deprecated 内部审计用途，UX 投影一律走 EventLog` 注释,守卫的配对约束也保留。

### 4.6 改：`apps/backend`

- **实体重建模**:`runs` 拆 `run`(逻辑)+ `attempt`(物理执行)。
- **RunSupervisor**(进程内,每 backend 一个):fork 子进程、持有 `Map<runId, { child, abortController }>`、解析子进程 stdout NDJSON 作低延迟通知 → `RunEventBus` emit;子进程退出写 `attempt.status`(`finally` 保证清理)。
- **EventProjection**:`GET /api/runs/:id/events` 端点机械映射 `EventSource.subscribe`。
- **重启重新发现**:启动扫 `attempt status=running`,按 `heartbeat_at` 新鲜度认领或标 interrupted。
- **并发控制**:`maxConcurrentRuns` 在 fork 前生效,超限 429 不排队;同 thread 单活跃 run 约束保留(超限 409)。

```sql
CREATE TABLE run (
  run_id     TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  status     TEXT NOT NULL,             -- running / succeeded / error / aborted / interrupted
  started_at INTEGER NOT NULL,
  ended_at   INTEGER
);
CREATE TABLE attempt (
  attempt_id  TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES run(run_id) ON DELETE CASCADE,
  pid         INTEGER,
  heartbeat_at INTEGER,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER
);
```

**run.status 联动规则**（`finally` 保证 attempt 退出回调写终态；heartbeat 超时为兜底）：

| 场景 | run.status 变更 | 触发时机 |
|---|---|---|
| attempt 正常退出(exit 0 + run_end) | → `succeeded` | 子进程退出回调 |
| attempt 抛错/exit 1 | → `error` | 子进程退出回调 |
| cancel → SIGTERM 干净退出 | → `aborted` | 子进程退出回调 |
| attempt 发 interrupt 事件后退出 | → `interrupted` | interrupt 事件到达（不是心跳超时） |
| heartbeat 超时（无任何终态信号） | → `interrupted` | 重启重发现 / 监控扫描 |
| `interrupted` + 用户 resume | → `running`（新 attempt#2） | resume 端点 fork 前 |

**并发计数口径**：`maxConcurrentRuns` 数 `attempt.status='running'`（物理槽，保护机器资源）。interrupted 的 run 无活进程，不占槽。

**heartbeat 配置**：`heartbeatIntervalMs=5000`（runner entry 定时写），`heartbeatTimeoutMs=20000`（4× 间隔，独立于 `cancelGraceMs`）。判活公式：`now - heartbeat_at > heartbeatTimeoutMs`。

**重启后 cancel**：从 `attempt` 表读 pid → 加 heartbeat 新鲜度校验 → `process.kill(pid, "SIGTERM")`（裸 pid 信号，无需 ChildProcess 对象）。

### 4.7 改：`apps/cli`

改为双模式：默认 `--local` 进程内执行（保留现有 REPL + harness 模式，可选接 `inMemoryEventLog` 验证 EventLog 路径）；新增 `--backend <url>` 远程模式（POST 202 拿 runId → GET /events 带 Last-Event-ID 订阅）。

### 4.8 HTTP API 变更(破坏性)

| 端点 | M8 | M9 | 说明 |
|---|---|---|---|
| `POST /api/threads/:id/runs` | 返回 `text/event-stream` | 返回 **202** `{ runId }` | 不再绑 SSE;启动子进程后立即返回 |
| `GET /api/runs/:id/events` | 无 | **新增** SSE 投影,支持 `Last-Event-ID` | 事件消费唯一入口 |
| `POST /api/runs/:id/cancel` | 204 | 204(语义增强:真 SIGTERM 子进程) | 行为变化,接口不变 |
| `POST /api/runs/:id/resume` | 无 | **新增** re-fork 新 attempt(mode='resume') | interrupt 恢复 |
| `GET /api/runs/:id` | — | **新增**(可选) run 元数据(status/时间) | 供轮询状态 |

---

## 五、前置债务清偿

### 5.1 统一迁移台账(修 `db.test` 红)

见 §4.5。一次性兼容:旧库可能已有 `user_version>0` 但 `_migrations` 为空 → `openDb` 首启时按 `user_version` 回填台账,避免重跑。

### 5.2 context 裁剪保 tool 对

新增共用 `repairToolPairs(messages)`,在 `token-budget` / `summarizing` / `sliding-window` 返回前调用:删除无配对 `tool_result` 的 `tool_use`、无配对 `tool_use` 的孤儿 `tool_result`,清理空 content 消息。防 Anthropic 400(tool_use without tool_result)。

### 5.3 Anthropic adapter role 交替

`anthropic-chat-model.ts`:合并所有 system 消息(不再只取末块)、相邻同 role 消息合并 content、过滤空 content、stream 分支显式处理 `thinking`/`redacted_thinking`(透传或显式忽略,不静默丢)。

---

## 六、技术契约不做(invariant)

- **EventLog 停在 runner entry 层,绝不下沉到 harness/framework** — harness `agent.run()` 只 yield,不认识 EventLog
- **执行者绝不依赖 backend 转发事件** — 子进程直写 EventLog;stdout 丢失不丢事件
- **EventLog 不取代 checkpointer 做 resume** — checkpointer 是 resume 唯一权威源
- **EventLog 不异构** — 所有 runner 的 `storage.eventLog` 由 backend 收敛下发;checkpointer 可异构
- **存活判定只看 `heartbeat_at`** — 不用 `kill(pid,0)`
- **`run_id` 贯穿所有 attempt** — 前端按 run_id 聚合,看到一条连续流
- **`event_log` 严格 append-only** — 无更新、无删除(并发安全 + 审计可信前提)
- **backend 不持有 checkpointer** — 只把 spec 的 checkpointer 配置原样转发

---

## 七、测试矩阵

| 区域 | 用例 |
|---|---|
| 执行解耦 | POST 返回 202+runId;子进程 fork 成功;事件全部落 `event_log` |
| EventSink/EventSource | 写侧只能 `append`(编译期);读侧只能 `read`/`subscribe`;sqlite/in-memory 行为一致 |
| 客户端断连继续跑 | SSE 断开后子进程跑完,DB 事件完整;重新 GET events 拿到全部 |
| 重连续读 | 带 `Last-Event-ID` 重连,只收 seq 之后事件,无重复无遗漏 |
| 冷读 | run 已结束后 GET events 仍完整回放 + done |
| backend 重启接管 | 杀 backend 留子进程存活 → 重启 → heartbeat 新鲜的被重新发现,事件继续投影;超时标 interrupted |
| cancel 真停 | cancel → SIGTERM → 几秒内退出,status=aborted;模型 fetch in-flight 被 signal 取消 |
| resume | interrupt → POST resume → 新 attempt 同 run_id,事件流连续;checkpointer 重建裁剪态 |
| 并发限流 | 活跃 run 达 maxConcurrentRuns → 429;同 thread 二次 run → 409 |
| 实体拆分 | 一 run 多 attempt;pid 属于不可变 attempt;run 聚合连续 |
| 迁移台账 | `db.test` 转绿:checkpointer 迁移名登记;新增 backend 迁移在旧库可执行;user_version 回填兼容 |
| 裁剪保对 | 跨边界裁剪后窗口内 tool_use/result 配对完整 |
| role 交替 | 连续同 role 合并;多 system 不丢;空消息过滤 |

---

## 八、CI Gate

```sh
bun run format && bun run lint && bun run typecheck && bun run test && bun run build
```

外加守卫:CI 校验 `packages/*/dist` 与源码一致(防 §4.5 dist 漂移再现)。

---

## 九、Commit 计划(独立 commit)

| # | Commit | 内容 |
|---|---|---|
| 1 | `fix(checkpointer-sqlite): unify migration ledger, rebuild dist (db.test green)` | 债务 §5.1 + dist 守卫 |
| 2 | `fix(framework): repairToolPairs across context managers (tool-pair integrity)` | 债务 §5.2 |
| 3 | `fix(adapter-anthropic): merge system/same-role, handle thinking, role alternation` | 债务 §5.3 |
| 4 | `feat(event-log): EventLog port (EventSink/EventSource) + sqlite/in-memory impls` | 新包 §4.1 |
| 5 | `feat(agent-spec): add runId/mode/resumeCommand/storage.eventLog fields` | §4.2 |
| 6 | `feat(adapter-anthropic): pass AbortSignal to fetch (cancel in-flight)` | §4.4 |
| 7 | `feat(runner-stdio): self-held EventSink append, SIGTERM abort, resume mode` | §4.3 |
| 8 | `feat(backend): run/attempt entity split + heartbeat liveness` | §4.6 实体 |
| 9 | `feat(backend): RunSupervisor fork subprocess + 202 + EventBus notify` | §4.6 执行 |
| 10 | `feat(backend): GET /runs/:id/events SSE projection + Last-Event-ID reconnect` | §4.6 投影 |
| 11 | `feat(backend): restart re-discovery via heartbeat + resume endpoint + concurrency` | §4.6 恢复 |
| 12 | `feat(cli): switch to POST runId → GET events subscription + e2e` | §4.7 + e2e |

---

## 十、验收清单

- [ ] CI 全绿(含 dist 守卫)
- [ ] `packages/event-log/` 新包(EventSink/EventSource + sqlite/in-memory)
- [ ] `db.test` 转绿(迁移台账归口)
- [ ] context 裁剪保 tool 对 + adapter role 交替
- [ ] `POST /runs` 返回 202+runId;`GET /runs/:id/events` SSE 投影 + 重连
- [ ] 子进程直写 EventLog;客户端断连/backend 重启不丢事件
- [ ] cancel 真停(fetch signal 透传)
- [ ] run/attempt 拆分 + heartbeat 单一真相判活
- [ ] resume re-fork 新 attempt,事件流跨子进程连续
- [ ] 并发 429 / 同 thread 409
- [ ] `apps/cli` 适配新 API
- [ ] M1–M8 零退化
- [ ] M9 retro 文档

---

## 附录：决策记录(grill 结论)

### 架构决策

| # | 决策 | 选定 |
|---|---|---|
| D1 | run 执行载体 | **子进程**(runner-stdio),进程隔离、抗 backend 崩溃、规避 512MB 上限 |
| D2 | 事件事实源 | **独立 `EventLog` port**(非复用 checkpoint_events),`EventSink`/`EventSource` 读写分离 |
| D3 | tail 机制 / 留存 | sqlite 纯轮询(PG 留 LISTEN/NOTIFY 口子);事件**永久留存**(TTL 后续) |
| D4 | 断线重连 | **支持**,`Last-Event-ID` → afterSeq,M9 一次做完 |
| D5 | 写入路径 | 子进程**直写 EventLog**;stdout 仅低延迟通知,断了不丢事件(铁律 4) |
| D6 | 崩溃恢复 | backend 重启按 **`heartbeat_at` 单一真相**重新发现;**废弃 `kill(pid,0)`** |
| D7 | 实体建模 | `runs` 拆 **run(逻辑)/ attempt(物理)**;run_id 贯穿,前端看连续流 |
| D8 | cancel 传导 | **AbortSignal 透传**到 adapter fetch,in-flight 即时中断 |
| D9 | resume | backend **re-fork 新 attempt**(mode='resume');checkpointer 唯一权威源 |
| D10 | maxConcurrentRuns | **生效**,超限 **429 拒绝**(不排队) |
| D11 | 遗留债务 | **顺带解决**:迁移台账 + 裁剪保对 + role 交替 |

### 实现细节决策（grill Q1–Q18）

| # | 问题 | 选定 | 理由 |
|---|---|---|---|
| Q1 | heartbeat 谁写 | **runner entry 直接 `UPDATE attempt`**（B） | EventSink 只管 event_log；entry 本就连 DB |
| Q2 | heartbeat 阈值 | **`heartbeatIntervalMs=5s` / `heartbeatTimeoutMs=20s`**，独立于 `cancelGraceMs` | 判死和主动停的量级差一个数量级 |
| Q3 | attempt_id 谁生成 | **backend fork 前生成并写入 spec** | 必须在 fork 之前落库，否则外键无处挂 |
| Q4 | `subscribe` 轮询间隔 | **可配 `opts.pollMs`**，默认 `DEFAULT_POLL_MS=250` | 调用方可选激进/省资源 |
| Q5 | seq 语义 | **单表 AUTOINCREMENT，`seq: number`** | M9 不做分布式，不预留分布式 seq |
| Q6 | 旧库兼容 | **首启扫全量 migration name 回填**（A） | 保证 `_migrations` 是权威台账 |
| Q7 | tablePrefix | **继续抛 `not yet supported`** | 无多前缀需求，快速失败 |
| Q8 | stdout NDJSON | **始终写**（B），backend 可忽略 | 低延迟通道，代价极低，删了反而丢实时性 |
| Q9 | EventSink 注入点 | **`EntryIO` 加可选参数**（A），生产自构建（B 兜底） | 测试注 in-memory，生产零配置 |
| Q10 | 重启后 cancel | **读 attempt.pid + heartbeat 新鲜度校验 → `process.kill`**（A） | 裸 pid 信号即可，与"判活废弃 kill(pid,0)"不冲突 |
| Q11 | run/attempt 状态联动 | **见 §4.6 状态表**；interrupt 事件到达转 interrupted，heartbeat 兜底 | 正常路径 attempt 回调写终态；heartbeat 只兜底 |
| Q12 | 并发计数口径 | **数 `attempt.status='running'`** | 物理槽保护机器资源 |
| Q13 | 多 system 合并 | **`\n\n` 拼接成单 string** | 最简单、无歧义 |
| Q14 | thinking/redacted_thinking | **显式 `else if` 识别 + 注释丢弃**（B） | 不静默丢，不透传（避免 core 类型改动） |
| Q15 | Tier 3 去留 | **保留调用点不动 + 接口加 `@deprecated`**（B） | 零回归面，继续做内部审计 |
| Q16 | CLI 适配 | **双模式：`--local` + `--backend <url>`**（B） | 保留本地链路，新增远程模式 |
| Q17 | e2e 等待策略 | **GET /events 阻塞等首事件 + 整体 timeout 兜底** | 测真路径，与生产客户端一致 |
| Q18 | smoke test EventLog | **inMemoryEventLog 注入为主 + 1 个临时 sqlite 端到端**（A+1B） | 快测试 + 真 IO 覆盖 durable 命脉 |

---

## 十一、未决 / 风险(实现前确认)

1. **子进程直写 DB 的并发安全**:子进程与 backend 并发写同 sqlite,依赖 `busy_timeout` + WAL + append-only。需基准压测验证高并发下无 `SQLITE_BUSY`;若不稳,退路是 PG(EventLog 接口不变,换 adapter)。**建议实现首阶段先压测再定稿。**
2. **轮询延迟体验**:sqlite 无 LISTEN/NOTIFY,tail 纯轮询(默认 250ms),SSE 推送有最高 250ms 延迟。可叠加进程内 `RunEventBus` 把同 backend 内的实时性补回(跨进程仍靠轮询)。
3. **孤儿子进程**:backend 永久下线(非重启)时存活子进程成孤儿。M9 让子进程在 `cancelGraceMs×N` 无人 cancel 时自我了断;外部 supervisor 留后续。
4. **API 破坏性**:`POST /runs` 语义变更影响所有客户端。M9 内同步改 `apps/cli`;确认 M8 无需兼容期外部消费者。

---

**Spec 结束。**
