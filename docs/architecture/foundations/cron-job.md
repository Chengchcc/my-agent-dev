---
id: foundations.cron-job
title: CronJob
status: current
owners: architecture
last_verified_against_code: 2026-06-23
summary: "CronJob 是「一条按时间表反复触发 Agent 运行的定时规则」。它是带独立生命周期的触发型 domain entity：Conversation 表达「谁在哪说话」、Run 表达「一次执行」，都表达不了「到点就自动起一棒」。CronJob 自带一张表做 CRUD，后端启动时（或单个 job 开启时）用 Bun.cron 在进程内注册定时器，到点经现有 dispatcher 起一次 main run，threadId 映射成 `<jobId>:owner` 实现「实体自带会话 + owner 成员」，使每一棒都能点进 `/conversations/<jobId>` 看详情。重试与超时是 job 上的两个策略字段，分别复用 retry ops 事件与 supervisor 取消/reaper 机制。"
depends_on:
  - backend.overview
used_by:
---

# CronJob

> 本页 `status: design`：尚未落地为代码，是 M21 的设计基线。落地后须把 `status` 改为 `current` 并补 `last_verified_against_code`。下文凡引用现有代码（`apps/backend/...` 的具体行）均为**已落地的复用点**，凡描述 `cron_job` 表、scheduler、`originKind="cron"` 均为**待落地的新增物**。

CronJob 是「一条按时间表反复触发 Agent 运行的定时规则」。用户在前端配一个 cron 表达式，到点后系统自动起一次 Agent 运行；每一次运行都能点进一个 Conversation 看它跑了什么。

## 这页解决什么问题

系统现在的运行都是**被动触发**的：人在对话里发消息（@提及触发）、人手动起一次（manual 触发）。这两条都需要一个「人此刻的动作」当起点。

缺的是**主动、周期性**的起点：「每天早上九点让运维 Agent 巡检一遍」「每隔十五分钟拉一次构建状态」。没有人在那一刻按按钮，触发源是时钟。

这件事属于哪个已有领域对象？按[设计哲学](../design-philosophy.md)的硬要求——**每个新概念必须说明为什么已有概念不能表达**——逐条检查：

- **Conversation** 回答「谁在一个共享空间里说话」。它没有「时间表」这层语义，也不会自己醒来。
- **Run** 回答「一次执行从发起到收尾」。它是被起出来的结果，不是「什么时候、按什么规律起」的规则。一条 CronJob 会起无数次 Run，Run 粒度太细，承不住「规则」这一层。

两者都表达不了「一条按时间表反复触发运行的规则」。这个语义没有现成本体能装，所以 CronJob 作为 new entity 成立。CronJob 是**触发型实体**，自带 `threadId`、复用现有执行层，触发源是时钟周期性点火。

## CronJob 的身份与字段

CronJob 自带一张表 `cron_job`，定义在 `apps/backend/src/infra/db/schema.ts`（与 `project` 同库 `backend.db`，沿用 M20 的 drizzle TS schema + `casing: "snake_case"` 约定，迁移由 `scripts/gen-drizzle.sh` 生成、按机器重建，不再手写 migration 数组）。

```ts
CronJob = {
  cronJobId: string,        // ULID，由 createCronJobService 通过 idGen() 生成
  name: string,             // 人可读名字
  agentId: string,          // 到点起哪个 Agent 的运行
  cronExpr: string,         // 5 段 cron 表达式（UTC 解释，见下文时区小节）
  prompt: string,           // 每次触发时喂给 Agent 的输入
  enabled: boolean,         // 开/关；关掉只停定时器，不删规则（存为 integer 0/1）
  timeoutMs: number,        // 单次运行的超时上限（超时策略，见下文）
  maxRetries: number,       // 单次触发失败后的重试次数（重试策略，见下文）
  createdAt: number,
  updatedAt: number
}
```

关键设计点：**CronJob 直接绑定一个派生 `threadId = "<cronJobId>:owner"`**。它不发明新的执行机制——到点就用这个 `threadId` 经现有 [run feature](../backend/overview.md) 的 dispatcher 起一次 main run。CronJob 只新增「定时触发规则」这一层语义，执行层、会话层、可观测层全部复用。

`cron_job` 表的 CRUD 走标准 feature 骨架（`entities.ts` / `ports.ts` / `adapter-sqlite.ts` / `service.ts` / `http.ts` / `index.ts`），与 `features/project/` 一一对应：service 是工厂函数，只有 Error 子类是 class，adapter 用 drizzle（参见 `features/project/adapter-sqlite.ts`）。

## 实体自带会话：为什么每一棒都点得进去

用户的硬要求是「点击跳转到一个 conversation 展示运行的详情」。做法是：

- 创建 CronJob 时，**同时建一个 `conversationId = cronJobId` 的 Conversation**，并 `addMember("owner", kind:"human"|"agent", ...)`。
- 每次定时触发 = 在这条会话里起一次新的 main run（`threadId = "<cronJobId>:owner"`），run 的 assistant 消息经 `supervisor.onRunMessage`（见 `main.ts`）直写该会话账本。
- 前端卡片的跳转目标就是 `/conversations/<cronJobId>`。

于是「一条 CronJob 一个会话、每次触发一棒运行、多棒在同一会话里按时间累积」。用户给的 `jobId:owner` 映射就是这个套路的直接落点。

## 调度机制：Bun.cron 在进程内注册

定时器用 Bun 内建的 `Bun.cron(schedule, handler)`——它在当前进程内按 cron 表达式跑回调，返回一个 `CronJob` 句柄（带 `.stop()`），调度在 **UTC** 下解释，且有**不重叠保证**：下一次触发时间在 handler（含其返回的 Promise）落定之后才计算，触发永不堆叠[[Cron - Bun]](https://bun.com/docs/runtime/cron)。这三条性质正好契合我们的需要——长驻服务、跨平台一致、单棒不重入。

> 命名提示：Bun 的句柄类型也叫 `CronJob`，与我们的domain entity 同名。代码里用 import 别名（如 `BunCron`）或限定路径区分，文档里「CronJob」一律指我们的实体，Bun 的句柄称「Bun 定时器句柄」。

调度器是一个独立服务 `CronScheduler`（建议放 `apps/backend/src/features/cron/scheduler.ts`），它的生命周期镜像 [run 生命周期](../backend/overview.md) 的 reaper：

- **注册时机**：后端启动时（`main.ts` 在各 service 构造完之后、`server.start()` 附近）遍历所有 `enabled=true` 的 CronJob，逐个 `Bun.cron(job.cronExpr, handler)`，把句柄存进 `Map<cronJobId, BunCronHandle>`。
- **单个 job 开启**：CRUD 里 enable / create 一个 job 时，立即注册一个新句柄并入 Map。
- **单个 job 关闭/删除/改表达式**：disable / delete / update 时，从 Map 取出旧句柄 `.stop()` 并删除；改表达式 = stop 旧的 + 注册新的。
- **进程退出**：`main.ts` 的 `shutdown()` 里调 `scheduler.dispose()`，遍历 Map 全部 `.stop()`，与 `supervisor.dispose()`、`larkBotRegistry.dispose()` 并列（见 `main.ts` 的 shutdown 序列）。

> 重要边界：`Bun.cron` 的进程内回调**不跨进程存活**——后端重启后定时器全没了。这没问题，因为**事实在 `cron_job` 表里**，启动时重新注册即可。这正是[事实与投影](./facts-and-projections.md)的体现：定时器是投影（机制），表才是事实。绝不用 `Bun.cron(path, schedule, title)` 那个写进 OS crontab 的形态——它会把状态泄漏到进程之外，违反「事实集中在 DB」。

## 触发 → 起一棒运行：复用 dispatcher

handler 触发时做的事，和对话里 @提及触发（`features/conversation/conv-svc-factory.ts` 的 `forkRun`）走的是**同一条** `dispatcher.dispatch(...)` 路径：

```ts
// CronScheduler 的 handler 内（伪代码，落地见 scheduler.ts）
const runId = idGen();
const spec = await buildCronSpec(job.agentId, threadId, job.prompt);
await dispatcher.dispatch({
  kind: "cron",                       // 新增 RunOriginKind
  runId,
  threadId: `${job.cronJobId}:owner`,
  spec,
  opts: { trace },
  origin: {
    conversationId: job.cronJobId,
    sourceLedgerSeq: 0,               // 无来源账本行（非消息触发）
    agentMemberId: "owner",
    surface: "cron",
    traceId: trace.traceId,
    traceparent: trace.traceparent,
    idempotencyKey: `${job.cronJobId}:${firedAtUnix}:run`, // 同一触发点幂等
    cronJobId: job.cronJobId,         // 反查链接
  },
});
```

spec 的构造按 `agentId` 读 Agent 的 model/permission/maxSteps 拼 schemaVersion=2 的 spec，不经 member 表派生。

**新增一个 RunOriginKind `"cron"`**：现状 `RunOriginKind = "mention" | "manual"`（`features/runtime-ops/types.ts`）。加 `"cron"` 后，会话投影的终结回调 `onRunComplete`（`features/conversation/projection.ts`）需要决定 cron run 是否参与 @提及级联——cron run 应当**被隔离**（在 `onRunComplete` 里直接 `clearAccumulator` 并 return），避免定时运行的输出去触发别的 Agent。`RunOriginRow` 上加一个可空 `cronJobId`（做反查链接 + 隔离判定）。

## 超时策略

每条 CronJob 带 `timeoutMs`。系统里已有一套超时机制——run 生命周期的 reaper（`RunLifecycleTracker` 的 `#startReaper` / `#reapStaleRuns`）按 `config.heartbeatTimeoutMs` 扫 attempt 心跳，超时把 run 标 `interrupted`。但那是**全局**心跳超时，是「执行卡死」的兜底，粒度不是「这条 job 允许跑多久」。

所以分两层：

1. **per-job 主动超时（前台）**：scheduler 在 dispatch 出 runId 后，`setTimeout(timeoutMs)` 武装一个看门狗；到点若该 run 仍 active，调 `cancel(runId)`（会向进程内 Agent 发 abort 并记 `cancel_requested` / `abort_sent` ops 事件）。run 正常结束则清掉看门狗。
2. **心跳 reaper（兜底）**：进程内执行整个卡死、连 abort 都收不到时，全局 reaper 仍会按 `heartbeatTimeoutMs` 把它标 `interrupted`。这是第二道防线，不替代 per-job 超时。

两层各司其职：per-job 超时回答「这条 job 不该跑超过 timeoutMs」，reaper 回答「执行是不是卡死了」。

## 重试策略

每条 CronJob 带 `maxRetries`。一次触发起的 run 若以非成功态收尾（`error` / `interrupted`，含被超时 cancel 的），scheduler 应在 `maxRetries` 次内重起同一棒。

挂载点是 `supervisor.onRunComplete`（`main.ts` 已注册了会话投影监听器，cron scheduler 再加一个）：监听器按 `origin.originKind === "cron"` 过滤，读该次触发已重试的次数，未达上限就 `dispatcher.dispatch` 重起（建议指数退避），并复用现成的 `retry_requested` / `retry_started` ops 事件（`features/runtime-ops/types.ts` 已有这两个 `RunOpsEventKind`）记录可观测。重试次数按「同一触发点」计数——以 `idempotencyKey` 里的 `firedAtUnix` 归并，或在内存维护 `Map<fireKey, attemptCount>`，落地时择一。

> 与 Bun.cron 不重叠保证的关系：重试是**同一棒内**的重起，不是新的定时触发。但实现上重试**不**阻塞 handler——`onRunComplete` 监听器被 supervisor 顺序 `await`，若在里面 `await sleep(backoff)` 会拖住别的监听器（账本终态写、锁释放），所以重试改用 `setTimeout` 退避**解耦**调度，handler 早早返回。这样一来 Bun 的「下一次触发在 handler 落定后才算」就不再覆盖整条重试链：高频 job 的下一次自然触发可能在重试还在飞时就到点，重叠会复现。
>
> 因此不重叠保证由 scheduler 自己的**单飞锁**（per-job `inFlight` 集合）补回：自然触发拿锁，拿不到（上一条 fire 链还在飞）就跳过；锁从自然触发起一直持有到整条链（run + 所有重试）落定，由 `onRunComplete` 的终态分支释放（成功 / 超时不重试 / 无重试配置 / 重试耗尽），或在 `fire()` 的 catch 里释放（buildSpec/dispatch 抛错、压根没产出 run）。重试**不**重新拿锁——它们续用已持有的锁。`unregister` / `dispose` 一并清锁，避免重注册的 job 被陈旧锁卡死。

## 不变量

1. CronJob 是触发型 new entity；它不走状态机，而是「同一规则反复触发、每次一棒独立运行」。
2. 事实在 `cron_job` 表；`Bun.cron` 进程内定时器是投影，重启后按表重建，绝不写进 OS crontab。
3. 每条 CronJob 自带 `conversationId = cronJobId` 的会话与 `threadId = "<cronJobId>:owner"`，每次触发一棒运行累积其中，故每棒都能点进 `/conversations/<cronJobId>`。
4. 触发起运行复用现有 `dispatcher.dispatch`，新增 `originKind="cron"` 并在会话投影中隔离（不参与 @提及级联）。
5. 超时分两层：per-job 看门狗主动 cancel + 全局心跳 reaper 兜底；重试在 `onRunComplete` 按触发点计数，上限 `maxRetries`，复用 retry ops 事件。
6. 不重叠由 scheduler 的单飞锁保证：一条 job 在前一条 fire 链（run + 重试）落定前，自然触发一律跳过——重试解耦成 `setTimeout` 后，Bun 自带的不重叠不再覆盖整条链，由此锁补回。

## 关联页面

- [后端总览](../backend/overview.md)（复用的执行层 + reaper 超时兜底）
- [事实与投影](./facts-and-projections.md)（表是事实、定时器是投影）
- [架构设计哲学](../design-philosophy.md)
