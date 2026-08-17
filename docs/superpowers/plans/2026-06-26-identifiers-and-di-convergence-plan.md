# 标识符收敛 + DI 修复 

> 状态：实施 plan（逐步可执行，含函数签名伪代码、测试改造、test DI 重建）
> 基准 HEAD：`05d6ed72`（分支 `feature/agent-session-integration`，`e5a4b390` 是其祖先）
> 所有 `file:line` 均基于 `git show 05d6ed72:` / `git grep 05d6ed72` 跟踪文件核验，非 dist/.turbo 工作树残留。
> 配套 spec：`2026-06-26-identifiers-and-di-convergence-spec-v2.md`（目标与 Phase 划分）。本文是它的「怎么一步步施工」展开，**把函数签名设计与测试改造提升为一等公民**。

---

## 0. 总纲：三条并行的改造线

这次重构不是「改生产代码、顺手修测试」，而是**三条线交织**：

```text
线 A  生产代码收敛   sessionId 正名 / SessionFactory / 跨run持久 / attemptSeq / 格式统一 / orchestrator 拆分
线 B  测试夹具建设   在已有 apps/backend/test-helpers/mock-deps.ts 上扩 fake（先建，再让 A 依附）
线 C  测试断言迁移   硬编码 id 字面量随 A 的每一步同步改（att-r1 / :owner / c:test / i:a / cr:o）
```

**铁律**：线 B 必须先于线 A 的对应 Phase 落地。现状测试夹具已有 `mock-deps.ts`（见 §1），但 `reactor.test.ts` 仍内联自己的记录型 `fakeSupervisor`，且缺 `fakeSessionFactory`。先把这些收进共享夹具，A 改接口时只改夹具一处。

---

## 1. 测试现状盘点（线 B/C 的施工依据，全部 05d6ed72 核验）

### 1.1 已有的共享夹具：两套并存，需收敛

| 夹具来源 | 位置 | 内容 |
|----------|------|------|
| backend 级 | `apps/backend/test-helpers/mock-deps.ts` | `testDir / testDB / mockConfig / mockOpsStore / mockAgentSvc / mockSupervisor(真 RunSupervisor) / testIdGen / waitForFinalize` |
| 包级 | `packages/test-helpers/src/index.ts` | **仅** `echoModel`（按 assistant 消息数回放的假 ChatModel） |

> `mock-deps.ts` 的 `mockSupervisor` 造的是**真 RunSupervisor + 假 eventLog/opsStore/tracer + 注入 db**——适合 run-executor 集成测试，不适合「断言派了哪些 run」的编排单测。

### 1.2 重复发明的内联 fake（DI 坏味道，散落各文件）

| fake | 位置 | 问题 |
|------|------|------|
| `fakeSupervisor()`（记录型，含 `startedRuns`） | `reactor.test.ts:88-94` | 与 mock-deps 的 `mockSupervisor` 重复，且这个是断言用的 spy |
| `fakeAgentSvc(agents)` | `reactor.test.ts:110` | agentSvc 替身 |
| `mockColumnConfigSvc()` | `reactor.test.ts:21` | 内联 |
| `mockDeliverableSvc()` | `reactor.test.ts:58` | 内联 |
| `new Database("/tmp/test-orchestrator-events.db")` | `reactor.test.ts:210` | 用真磁盘 db，应换 `:memory:` |

### 1.3 硬编码 id 字面量（线 C 要随 A 改）

| 字面量 | 位置 | 随哪步改 |
|--------|------|---------|
| `expect(attemptId).toBe("att-r1")` | `supervisor.test.ts:10` | Phase 3 attempt→seq |
| `{ runId, attemptId: \`attempt-${runId}\` }` | `reactor.test.ts:96` | Phase 3（fake 返回值加 seq） |
| `expect(...threadId).toBe(\`${planned.issueId}:planner\`)` | `reactor.test.ts:250` | Phase 5（确认仍是 `:${agentId}` 形态，公式不改、断言核对） |
| `expect(issue.threadId).toBe("test-iss-0:owner")` | `issue/service.test.ts:38` | Phase 5 格式统一 |
| `expect(issue.threadId).toBe(\`${issue.issueId}:owner\`)` | `issue/service.test.ts:46` | Phase 5 格式统一 |
| `threadId: "c:test"` / `"i:a"` / `"cr:o"` | `run-executor.test.ts:52/62/75` | Phase 0 正名 + Phase 5（改 `TID.*`） |

### 1.4 被真实依赖拖累、无法注入替身的测试

- `agent-session.test.ts` `new AgentSession({ model })`——直接构造真类，没有「轻量 session 替身」。`SessionFactory` 引入后，依赖 session 的上层测试可注入假 factory。
- `reactor.test.ts:210` 拖进真磁盘 sqlite（`/tmp/...events.db`）——测编排逻辑却连真 sqlite 一起跑。
- `run-executor.test.ts`（已存在）目前靠 `mockSupervisor` 真 RunSupervisor 跑完整路径——Phase 1 后可改注入 `fakeSessionFactory` 断言「复用」「runId 透传」。

---

## 2. 线 B 先行：补强共享 test 夹具（PR-B0）

**这是第一个要落的 PR，先于所有生产代码改动。** 在 `apps/backend/test-helpers/mock-deps.ts` 上扩，外加 `TID` 集中 id 生成。每个夹具都是「窄接口的最小假实现 + 合理缺省 + 可覆盖」，照搬生产代码 `OrchestratorDeps.projectSvc` 只声明 `getById` 的窄依赖风格（`reactor.ts:39`）。

### 2.1 三类 fake 的分类法（贯穿全 plan）

```text
A 记录型 / spy  —— 只为断言「被调用了什么」。内部存一个数组，方法 push 进去。
                  例：fakeSupervisor.startedRuns、fakeRunStatus.calls
B 数据型 / stub —— 只为「喂一个合理返回值」。给默认值 + 可 override。
                  例：fakeAgentSvc(getById 返回固定 agent)、fakeProjectSvc
C 替身工厂      —— 造一个能「跑」的轻量真对象，由 echoModel 驱动，不连真模型/真 sqlite。
                  例：fakeSessionFactory（返回 echoModel 驱动的轻量 AgentSession）
```

### 2.2 新增夹具签名（伪代码）

```ts
// apps/backend/test-helpers/mock-deps.ts （在现有导出基础上新增）

// ── id 夹具：集中生成测试 id，杜绝散落字面量 ──────────────────
export const TID = {
  conversation: (s = "c1") => s,
  /** 正名后的 sessionId 公式：上下文:agent */
  session: (ctx = "c1", agent = "a1") => `${ctx}:${agent}`,
  /** Phase 5 统一格式（与 session 同形，语义区分用） */
  issueSession: (issue: string, agent: string) => `${issue}:${agent}`,
  run: (s = "r1") => s,
};

// ── A 记录型：编排断言用的 spy supervisor ─────────────────────
export interface RecordingSupervisor {
  startedRuns: Array<{ runId: string; sessionId: string; spec: Record<string, unknown> }>;
  startMainRun(runId: string, sessionId: string, spec: Record<string, unknown>):
    Promise<{ runId: string; attemptId: string; attemptSeq: number }>;
  onRunComplete(fn: (...a: unknown[]) => void): void;
}
export function recordingSupervisor(): RecordingSupervisor;  // 取代 reactor.test.ts:88 内联版

// ── A 记录型：run_status / onComplete 回调断言用 ──────────────
export function recordingRunStatus(): {
  calls: Array<{ runId: string; phase: string }>;
  onRunStatus: (s: { runId: string; phase: string; detail?: string; updatedAt: number }) => void;
};

// ── B 数据型：窄接口 stub（覆盖现 reactor.test 内联） ──────────
export function fakeAgentSvc(agents?: Record<string, FakeAgent>): AgentServiceLike;   // 取代 :110
export function fakeColumnConfigSvc(over?: Partial<...>): ColumnConfigService;        // 取代 :21
export function fakeDeliverableSvc(byIssue?: Record<string, DeliverableRow[]>): {     // 取代 :58
  listByIssue(issueId: string): DeliverableRow[];
};
export function fakeProjectSvc(over?: Partial<Project>): {
  getById(id: string): { autoOrchestrate: boolean; projectId: string };
};

// ── C 替身工厂：Phase 1 落实现 ────────────────────────────────
export function fakeSessionFactory(opts?: {
  /** 注入 echoModel 脚本，驱动轻量 session 自动跑完 */
  script?: EchoScript;
  /** 记录每次 getOrCreate 的 sessionId，用于断言「复用同一实例」 */
}): SessionFactory & {
  created: Map<string, AgentSession>;   // sessionId → 唯一实例（断言复用）
  promptCalls: Array<{ sessionId: string; input: string; runId?: string }>; // 断言 runId 透传
};

// ── builder：fat deps 一键造，测试只覆盖关心的字段 ────────────
export function makeOrchestratorDeps(over?: Partial<OrchestratorDeps>): OrchestratorDeps;
export function makeRunDeps(over?: Partial<RunDeps>): RunDeps;          // Phase 1 后
```

### 2.3 落地步骤

1. 把 `reactor.test.ts` 的 `fakeSupervisor`（`:88`，记录型）剪进 mock-deps → 命名 `recordingSupervisor`（与已有真 `mockSupervisor` 区分）。
2. 把 `fakeAgentSvc`（`:110`）、`mockColumnConfigSvc`（`:21`）、`mockDeliverableSvc`（`:58`）剪进，导出。
3. `fakeSessionFactory` 复用 `packages/test-helpers` 的 `echoModel` + framework 已有 `inMemoryCheckpointer`，造轻量 `AgentSession`，**不碰真 sqlite / AnthropicChatModel**。本 PR 先占位（接口 + 最小实现），实现细节随 Phase 1。
4. **暂不改任何测试文件的引用**——本 PR 只新增夹具 + 自带夹具自测。引用替换放进各 Phase（接口还会变，先替换会白改）。

> 验收：`mock-deps.ts` 导出上述夹具且有最小自测；现有测试全绿（未改动它们）。

---

## 3. Phase 0 — 类型地基 + 第一批测试迁移（PR-0）

### 3.1 生产代码（线 A）

1. `AgentSessionConfig`（`agent-session.ts:32`）新增 `sessionId?: string`，保留 `threadId?`（`:35`）为 `@deprecated` 别名，构造里 `const sessionId = config.sessionId ?? config.threadId`。
2. `create-agent.ts` 的 `CreateAgentConfig` 同样处理。
3. `Checkpointer` 接口（`checkpointer.ts:45`）七个方法（`load:46 / save:47 / saveInterrupt:49 / consumeInterrupt:50 / appendEvent:56 / readEvents:60 / deleteThread:63`）入参名 `threadId` → `sessionId`（纯参数名，类型不变；存储列名 `thread_id` 不动）。
4. 新增 `SessionFactory` / `SessionSpec` 接口（spec §3.2），仅类型，无实现。
5. 返回 `{ runId, attemptId }` 处新增 `attemptSeq: number`：`run-executor.ts:79`、`supervisor.ts:176`；`attemptId` 保留 `@deprecated`。runtime-ops 那 7 处返回 `attemptId` 的点（`runtime-ops/service.ts:42/79/86/273/312/396/412`）**Phase 0 只加 `attemptSeq` 字段、`attemptId` 并存**（值仍是 `att-${runId}`，纯类型扩展，不动查询）；**真正把读写切到 seq、删 `attemptId` 留到 Phase 3**（§6.3，连同存储迁移）。这样 Phase 0 是无行为变更的纯类型 PR，Phase 3 才动 SQL 与展示——两阶段边界清晰，避免类型与存储同 PR 混改。

### 3.2 测试改造（线 B+C）

1. **正名相关断言**：`run-executor.test.ts:52/62/75` 的 `threadId: "c:test"/"i:a"/"cr:o"`——因别名兼容**这一步可不改仍绿**；建议同 PR 改成 `sessionId:` + `TID.session(...)`。
2. checkpointer 相关测试（`file-checkpointer.test.ts` / `in-memory.test.ts`）入参名同步。

> 验收：全测试绿；`git grep -n 'threadId:' 05d6ed72 -- '**/*.test.ts'` 命中数显著下降（剩存储层）。

---

## 4. Phase 1 — executeAgentRun 重构（PR-1，最大收益）

### 4.1 目标函数签名设计（核心伪代码）

把现 17 字段袋（`run-executor.ts:37-65` 的 `ExecuteAgentRunOpts`：runId/threadId/agentId/input/config/agentSvc/supervisor/opsStore/convPort/conversationId/surface/senderName/originKind/origin/onAssistantMessage/onRunStatus/onComplete）拆成**三组**：

```ts
// ① RunDeps：稳定能力，组装根造一次，所有 run 共享。注入而非函数体 new。
export interface RunDeps {
  sessionFactory: SessionFactory;   // 取代函数体 new AnthropicChatModel/sqliteCheckpointer/new AgentSession
  supervisor: RunSupervisor;        // 起 run/attempt 行 + 终态
  opsStore: RuntimeOpsStore;        // ops 事件
  agentSvc: AgentService;           // getById 决定 model/cwd（造 spec 时用，不在执行体内 new）
  convPort?: ConversationPort;      // 仅会话触发源需要
}

// ② RunRequest：每次调用真正变化的数据。
export interface RunRequest {
  runId: string;
  sessionId: string;                // = 原 threadId，正名
  agentId: string;
  input: string;
  origin: RunOrigin;                // ③ 见下
  onAssistantMessage?: (revision: Record<string, unknown>) => void;
  onRunStatus?: (s: RunStatus) => void;   // 已存在（:57-65），保留
  onComplete?: (runId: string, status: string) => void;
}

// ③ RunOrigin：三触发源判别联合，替代散落的 surface/senderName/originKind/origin/conversationId
export type RunOrigin =
  | { kind: "conversation"; conversationId: string; surface: string; senderName: string }
  | { kind: "cron"; cronJobId: string }
  | { kind: "orchestrator"; issueId: string; fromStatus: string };

// 新签名：
export async function executeAgentRun(
  deps: RunDeps,
  req: RunRequest,
): Promise<{ runId: string; attemptSeq: number }>;
```

函数体收缩为（伪代码）：

```ts
async function executeAgentRun(deps, req) {
  const { runId, sessionId, agentId, input, origin } = req;
  const { attemptSeq } = await deps.supervisor.startMainRun(runId, sessionId, { agentId });

  // 造 spec 所需的 per-agent 资料仍读 agentSvc，但 model/checkpointer 的 new 已在 factory 内部/组装根
  const agent = await deps.omaSvc.getById(agentId);
  const spec = buildSessionSpec(agent, origin, deps);   // 纯组装，无 I/O new
  const session = deps.sessionFactory.getOrCreate(sessionId, spec);  // ← 复用点

  wireRunListeners(session, { runId, attemptSeq, ...req });  // onAssistantMessage/onRunStatus/onComplete
  void session.prompt(input, { signal, runId }).catch(...);  // ← runId 透传（ID#4）
  return { runId, attemptSeq };
}
```

> **关键变化**：函数体不再有 `new AnthropicChatModel`(:124) / `sqliteCheckpointer`(:175) / `new AgentSession`(:185) / `mkdirSync`(:122)——`mkdirSync` 随 cwd 准备移进 factory 的 materialize；`registerSession/removeSession`(:34) 由 factory 内部 registry 接管。

### 4.2 ID#4 harness 改动伪代码

```ts
// agent-session.ts:170  —— opts 增 runId
async prompt(text: string, opts?: { signal?: AbortSignal; runId?: string }): Promise<void> {
  ...
  await this.#agent.run(messages, { signal: opts?.signal, maxSteps, runId: opts?.runId });
}
// run-loop.ts —— 回退保留：rt.runId = opts.runId ?? thread.id（正常路径总传 runId）
```

ordinal 规则定死：`assistantMessageId(runId, ordinal)` 的 ordinal **按 run 重置**（每个 runId 从 0 起），因为 messageId 已含 runId 切片，跨 run 不会撞。

> 事实核对（`05d6ed72`）：此结论已天然成立——`run-loop.ts` 里 `assistantOrdinal` 恒为 0，且 `create-agent.ts` 每次 run/continue/resume 都重置 `rt.runId = opts.runId ?? thread.id; rt.toolStates = []; rt.assistantBlocks = []`，即已按 run 重置。所以 ID#4 真正要做的只是「让 backend 总传 runId」，无需新增重置逻辑。
> **连带清理**：`run-executor.ts:211/216/217` 现有的 `let lastAssistantOrdinal = 0` + `/:assistant:(\d+)$/.exec(...)` + `Math.max(...)` 这段 ordinal 追踪是旧 buildRunStatusRevision 时代的残留（DI#3 已删该函数），与 runId 透传新路径并存会成死逻辑——本 PR 一并删除。

### 4.3 main.ts 组装根（伪代码）

```ts
// createSessionFactory 在组装根造一次，把所有具体 new 收这里
const sessionFactory = createSessionFactory({
  makeModel: (agent) => new AnthropicChatModel({ apiKey: config.anthropicApiKey, model: agent.modelName, ... }),
  makeCheckpointer: (sessionId) => sqliteCheckpointer({ db: eventsDb }),  // eventsDb 已存在 main.ts:69
  makeContextManager: () => pipeContextManagers(toolResultTruncator, autoSummarize),
  defaultPlugins, defaultTools,
  reaperIntervalMs: config.reaperIntervalMs,   // Phase 2 回收用
});
const runDeps: RunDeps = { sessionFactory, supervisor, opsStore, agentSvc, convPort };
```

### 4.4 测试改造（线 B+C）—— 本 Phase 测试工作量最大

1. **落实 `fakeSessionFactory` 实现**（PR-B0 占位）：返回 echoModel 驱动的轻量 session，让 executeAgentRun 测试不再连真 AnthropicChatModel / sqlite。
2. `run-executor.test.ts`（已存在）改注入 `fakeSessionFactory` + `recordingSupervisor`，新增断言：
   - 「同 sessionId 两次 `executeAgentRun` → `fakeSessionFactory.created` 仅一个实例」；
   - 「`prompt` 被调用时带 `runId`」（查 `promptCalls[].runId`）。
3. 三处调用方更新构造方式：
   - `conv-svc-factory.ts:156` `startAgentRun` 改用 `RunDeps`/`RunRequest`（DI#7 大概率退化为一行，见 §8.5）。
   - `cron/scheduler.ts:39` `executeAgentRun` 调用改 `origin: { kind: "cron", cronJobId }`。
   - `orchestrator/reactor.ts:136` 改 `origin: { kind: "orchestrator", issueId, fromStatus }`，用 `makeRunDeps`。
4. `reactor.test.ts:210` 把真磁盘 sqlite 换成 `testDB()`（`:memory:`）。

> 验收：executeAgentRun 有独立单测且不依赖真实模型/sqlite；reactor.test 不再 new 真磁盘 db。

---

## 5. Phase 2 — 跨 run 持久 + 回收（PR-2）

### 5.1 生产代码（伪代码）

```ts
// run-executor.ts:204-206  finalizeOnce —— 去掉 dispose/removeSession
const finalizeOnce = (status: string) => {
  if (finalized) return; finalized = true;
  req.onComplete?.(runId, status);
  // ⛔ 删除：if (session.state !== "waiting") { session.dispose(); removeSession(runId); }
  // session 留在 factory registry，等同 sessionId 下一个 run 复用
};

// session-factory.ts —— registry + lastUsedAt + reaper
function createSessionFactory(deps) {
  const reg = new Map<string, { session: AgentSession; spec: SessionSpec; lastUsedAt: number }>();
  function getOrCreate(sessionId, spec) {
    const hit = reg.get(sessionId);
    if (hit) {
      assertSpecCompatible(hit.spec, spec);   // ← 见下「spec 复用语义」，不一致直接 throw
      hit.lastUsedAt = Date.now();
      return hit.session;
    }
    const session = materialize(spec);   // 这里才 new model/checkpointer/AgentSession
    reg.set(sessionId, { session, spec, lastUsedAt: Date.now() });
    return session;
  }
  function dispose(sessionId) { reg.get(sessionId)?.session.dispose(); reg.delete(sessionId); }
  // idle reaper（继承 waiting 豁免）
  if (deps.reaperIntervalMs > 0) setInterval(() => {
    const now = Date.now();
    for (const [sid, e] of reg) {
      if (e.session.state === "waiting") continue;            // ← 豁免（继承 :204 逻辑）
      if (e.session.state === "running") continue;            // ← 跑动中不回收，避免抢栈下 dispose
      if (now - e.lastUsedAt > deps.idleTimeoutMs) dispose(sid);
    }
  }, deps.reaperIntervalMs);
  return { getOrCreate, dispose, disposeAll: () => { for (const s of reg.keys()) dispose(s); } };
}
// main.ts shutdown hook → sessionFactory.disposeAll()
```

### 5.1a 跨 run 持久复用必须先定的两条语义（审查发现的实质空白，落地前必须拍板）

跨 run 复用 session 引入两个 per-run 临时对象时代不存在的新语义，plan 旧稿未定义，**PR-1/PR-2 落地前必须先定**，否则并发下会丢任务或用错配置。

**① 同 sessionId 并发 prompt 的串行化语义。** `agent-session.ts` 的 `prompt()` 在 `state === "running"` 时 **`throw`**（底层 `create-agent.ts` 亦 `throw "Agent is already running"`）。session 持久后，若两个 run 命中同一 sessionId 并发到达，第二个 `void session.prompt().catch()`（`run-executor.ts:249`）会被 catch 成 `status: "error"`——**不是排队，是静默丢任务**。三种可选语义，本 plan 推荐 **(a) 队列串行**：

| 选项 | 行为 | 取舍 |
|------|------|------|
| (a) 队列串行（推荐） | factory 内每个 session 持一个 promise 链，`getOrCreate` 返回的 session 上 prompt 自动排队，前一个 run 的 prompt settle 后再起下一个 | 符合「一条记忆线串行推进」的语义；实现需在 factory 包一层 `enqueuePrompt(sessionId, fn)` |
| (b) 显式拒绝 | 命中 running session 时 `getOrCreate` 抛 `SessionBusyError`，调用方决定重试/排队 | 把并发决策上推到 supervisor，factory 简单但调用方要处理 |
| (c) 不复用 | 同 sessionId 但已 running，则另造临时 session（退回旧行为） | 放弃复用收益，仅作降级兜底 |

> 决策点：编排（`${issueId}:${agentId}`）正常不会让同一 agent 在同一 issue 上并发两 run，但会话（用户连发两条消息）和 cron（与会话撞同一 owner sessionId）可能并发。推荐 (a)，并在 `session-factory.test.ts` 加「同 sessionId 两 prompt 串行执行、第二个不被吞成 error」用例。

**② getOrCreate 二次传入不同 spec 的语义。** 命中即 `return hit.session` 会**静默丢弃新 spec**。当同一 sessionId 第二次带不同 `agentId`/`modelName`/`cwd`（issue/cron 把 `:owner` 改 `:ownerAgentId` 后换 owner、或改 model 时会撞）时，旧配置静默生效。规则：**命中时校验 spec 关键字段一致**（`agentId` / `modelName` / `cwd`），不一致则 `throw SessionSpecMismatchError`（或显式 `dispose` 后重建，二选一，推荐 throw 暴露问题）：

```ts
function assertSpecCompatible(existing: SessionSpec, incoming: SessionSpec) {
  for (const k of ["agentId", "modelName", "cwd"] as const) {
    if (existing[k] !== incoming[k])
      throw new SessionSpecMismatchError(`sessionId reuse with changed ${k}: ${existing[k]} → ${incoming[k]}`);
  }
  // plugins/tools/checkpointer/contextManager 视为由 agentId 唯一决定，不逐项比
}
```

### 5.2 测试改造

1. **新增 `session-factory.test.ts`**：`getOrCreate` 命中复用、idle reaper 回收、waiting 态豁免、running 态豁免、显式 `dispose`。用 `fakeCheckpointer`(inMemory) + `echoModel`，**不碰真 sqlite**。
2. **并发语义用例**：同 sessionId 两个 prompt 串行执行，第二个不被吞成 `error`（验证 §5.1a 选项 a 的队列）。
3. **spec 复用用例**：同 sessionId 第二次带不同 `agentId`/`modelName`/`cwd` → `assertSpecCompatible` 抛 `SessionSpecMismatchError`。
4. 内存泄漏回归：长跑多 sessionId 后 registry size 受控。

---

## 6. Phase 3 — attempt → seq（PR-3）

### 6.1 生产代码

```ts
// events-schema.ts:29-43  attempt 表
export const attempt = sqliteTable("attempt", {
  // ⛔ attemptId: text().primaryKey(),
  runId: text().notNull().references(() => run.runId, { onDelete: "cascade" }),
  seq: integer().notNull(),
  startedAt: integer(), heartbeatAt: integer(), endedAt: integer(),
}, (t) => [primaryKey({ columns: [t.runId, t.seq] })]);
// run_ops_event.attemptId(:50, nullable text, 非 FK) → attemptSeq integer
```

```ts
// supervisor.ts:178/186 —— 注意：SELECT MAX(seq) + INSERT 必须在同一 db.transaction() 内
// （现 startMainRun :181 已包 transaction；bun:sqlite 单连接串行写 + 复合 PK (runId,seq) 双重兜底，
//   只要这两句不被拆出事务，同 runId 并发重试不会取到相同 seq 而撞 PK）
// ⛔ const attemptId = `att-${runId}`;
const seq = this.#db.query("SELECT COALESCE(MAX(seq),0)+1 AS n FROM attempt WHERE run_id=?").get(runId).n;
this.#db.run("INSERT INTO attempt (run_id, seq, started_at) VALUES (?,?,?)", [runId, seq, now]);
return { runId, attemptSeq: seq };
// #finalizeRun(:136) / #markProjectionDegraded(:154) 参数 attemptId → attemptSeq:number|null
// reaper(:113/:126) row.attempt_id → row.seq
```

读取：`runtime-ops/service.ts:154/235` 的 `ORDER BY started_at DESC` → `ORDER BY seq DESC`；展示层 `attemptId.slice` → `#${seq}`。

### 6.2 测试改造

1. `supervisor.test.ts:10` `expect(attemptId).toBe("att-r1")` → `expect(attemptSeq).toBe(1)`；新增「同 run 第二次 attempt → seq=2」。
2. `reactor.test.ts:96` fake 返回加 `attemptSeq`。
3. drizzle migration 新增一支（复合 PK）；ops store/service 测试同步。

---

## 7. Phase 4 §DI#8 — createOrchestrator 拆分（PR 内或独立，含伪代码）

现 `createOrchestrator`（`reactor.ts:55-241`）闭包握三件事。拆成：

```ts
// ① buildPromptVars 提为模块级纯函数（现 :72 内嵌 → 外提，零依赖）
export function buildPromptVars(issue: IssueRow, deliverables: DeliverableRow[]): PromptVars { ... }

// ② StepRunner：派活。窄依赖用 Pick 收
type StepRunnerDeps = {
  agentSvc: Pick<AgentService, "getById">;
  columnConfigSvc: ColumnConfigService;
  deliverableSvc: { listByIssue(id: string): DeliverableRow[] };
  opsStore: RuntimeOpsStore;
  idGen: () => string;
  convPort?: OrchestratorDeps["convPort"];
  now?: () => number;
  runDeps: RunDeps;           // 调 executeAgentRun 用
};
export function createStepRunner(d: StepRunnerDeps) {
  async function startStep(issue: IssueRow): Promise<{ runId: string } | null> {
    // 现 :101-158 逻辑：nextTransition → getById → buildPromptVars → renderPrompt
    //   → sessionId = `${issue.issueId}:${t.agentId}` → executeAgentRun(runDeps, {origin:orchestrator})
    //   → emitIssueEvent
  }
  return { startStep };
}

// ③ TransitionReactor：终态门控 + 推进
type TransitionReactorDeps = {
  issueSvc: IssueService;
  projectSvc: { getById(id: string): { autoOrchestrate: boolean; projectId: string } };
  opsStore: RuntimeOpsStore;
  stepRunner: { startStep(i: IssueRow): Promise<{ runId: string } | null> };  // ← 依赖 ②
};
export function createTransitionReactor(d: TransitionReactorDeps) {
  async function onRunComplete(_sid, runId, status, kind) {
    // 现 :161-240 逻辑：gate origin_kind → 幂等 → applyTransition → 递归 d.stepRunner.startStep
  }
  return { onRunComplete };
}

// ④ 薄壳：保持 main.ts 接线不变，仍返回 { startStep, onRunComplete }
export function createOrchestrator(deps: OrchestratorDeps) {
  const stepRunner = createStepRunner({ ...pick(deps), runDeps });
  const reactor = createTransitionReactor({ ...pick(deps), stepRunner });
  return { startStep: stepRunner.startStep, onRunComplete: reactor.onRunComplete };
}
```

**测试改造**：`reactor.test.ts` 可直接测 `createStepRunner`（注入 `recordingSupervisor`/`fakeSessionFactory` 经 runDeps）与 `createTransitionReactor`（注入假 `stepRunner` spy 断言「推进时是否调 startStep」），不再整坨拖真 sqlite。

---

## 8. Phase 4 周边 DI 中高问题（PR-5，逐项展开）

> 这一批与枢纽解耦，各自一个小 PR、可并行。每项都核到 `05d6ed72` 行号，给 before/after。

### 8.1 `DI#2` RunSupervisor 拆分（SRP/DIP，高）

**病灶**（`supervisor.ts:32`）：一个类同时管四件事——生命周期（`#active` map）、events.db 直接 SQL（`:186` 裸 `INSERT INTO attempt`）、reaper 定时器（`#startReaper` `:71-89`）、三组监听器分发（`#onRunComplete:35` / `#onRunEvent:39` / `#onRunMessage:42`）；构造里 `this.#db = opts.db ?? new Database(\`${opts.config.dataDir}/events.db\`)`（`:50`）踩 DIP。

> 注：events.db 的**迁移**已不在类内内联,05d6ed72 已抽到 `events-db-migrations.ts`（`:9` import + `:53` `runEventsDbMigrations(this.#db)`）——这部分无需再动,参考文档「events.db 迁移」措辞按当前已部分缓解理解。

**做法**：

```ts
// ① DIP：db 强制注入，去掉 ?? new Database
// before (supervisor.ts:50)
this.#db = opts.db ?? new Database(`${opts.config.dataDir}/events.db`);
// after —— 构造只收 db，new 上移 main.ts:69（eventsDb 已存在，直接传）
constructor(opts: RunSupervisorOptions) {  // opts.db 改必填
  this.#db = opts.db;
  this.#db.exec("PRAGMA busy_timeout=5000");   // PRAGMA/migration 仍可留构造或交组装根
  runEventsDbMigrations(this.#db);
  this.#reaper = new Reaper(opts.config, () => this.#reapStaleRuns());  // ② 见下
}

// ② SRP：reaper 拆成协作者，supervisor 不再自己持 setInterval
class Reaper {
  constructor(cfg: { reaperIntervalMs: number; heartbeatTimeoutMs: number }, tick: () => Promise<void>);
  start(): void; stop(): void;   // 收 supervisor.ts:71-89 + :272 clearInterval
}

// ③ SRP：events.db 的裸 SQL 收进 RunStore（参照 runtime-ops 的 store/service 分层）
interface RunStore {
  insertAttempt(runId: string, seq: number, startedAt: number): void;   // 收 :186
  finalizeRun(runId: string, attemptSeq: number | null, status: string): boolean; // 收 #finalizeRun:136
  markDegraded(runId: string, attemptSeq: number | null, err: unknown): void;     // 收 :154
}
// supervisor 改持 RunStore，不再自己拼 SQL

// ④ ISP：删除 RunSupervisorOptions.eventLog
// supervisor.ts:12 声明 eventLog: EventLog，但 git grep 05d6ed72 全文件仅命中 :12 这一处声明，
// #onRunMessage/#onRunEvent 都没调它 .append() → 删字段 + 删所有传它的调用点（main.ts / mock-deps.ts:69）
```

**测试改造**：`supervisor.test.ts` 用 `testDB()`（`:memory:`）注入；`mock-deps.ts:65` 的 `mockSupervisor` 去掉假 `eventLog`（`:67-71`）。`Reaper` 可独立测时间逻辑（注入假 tick）。

### 8.2 `DI#4` RuntimeOpsService 拆分（SRP，高）

**病灶**（`runtime-ops/service.ts:90` `createRuntimeOpsService`）：返回对象 7 个大方法、四类关注点挤一处——
- **运行管理**：`listRuns:104`、`cancel:296`
- **诊断**：`getRunDetail:221`、`getTraceDetail:389`
- **监控**：`getAgentRuntime:337`、`listSurfaces:429`
- **采集入口**：`ingestLarkHeartbeat:365`

`listRuns`（`:104`）的过滤分**两段**，OCP 病灶分布要分清，否则重构方案会错位：
- **SQL 层 `sql +=` if 链 4 段**（`:120` agentId / `:124` sessionId(thread_id) / `:130` conversationId LIKE 前缀 / `:134` status）——这部分能收进查询构造器。
- **post-query `items.filter` 4 段**（`:203` transport / `:206` heartbeat 过期 / `:211` heartbeat 活跃 / `:216` traceId）——查完后在 JS 里二次过滤，依赖 SQL 取回后才算出的派生字段（runnerTransport、heartbeat 时效），**无法**收进 `buildRunQuery`。

> 纠错记录：上一稿把这 8 段都当 SQL if 链是错的——只有前 4 段在 SQL，行号也偏移了一行。重构只能消 SQL 那 4 段的 OCP；后 4 段单独用 predicate 表处理（见下 ③）。

**做法**：

```ts
// ① 按四类关注点拆成 4 个窄 service，各自独立 deps
createRunQueryService({ db, supervisor })      // listRuns + cancel
createRunDiagnosticsService({ db, eventLog })  // getRunDetail + getTraceDetail
createRuntimeMonitorService({ db, supervisor, heartbeatTimeoutMs, getAgentName }) // getAgentRuntime + listSurfaces
createHeartbeatIngestService({ db })           // ingestLarkHeartbeat
// main.ts 组装根分别 new，路由按需取

// ② SQL 层 4 段 if 链 → filter spec → 查询构造器（消 SQL 侧 OCP），现 :120/:124/:130/:134
type RunSqlFilter = { agentId?: string; sessionId?: string; conversationId?: string; status?: string };
function buildRunQuery(f: RunSqlFilter): { sql: string; args: unknown[] } {
  const clauses: string[] = ["1=1"]; const args: unknown[] = [];
  const add = (cond: string, v: unknown) => { clauses.push(cond); args.push(v); };
  if (f.agentId) add("r.agent_id = ?", f.agentId);
  if (f.sessionId) add("r.thread_id = ?", f.sessionId);           // 正名后字段名待 ID#1b
  if (f.conversationId) add("r.thread_id LIKE ? ESCAPE '\\'", `${escapeLike(f.conversationId)}:%`);
  if (f.status) add("r.status = ?", f.status);
  return { sql: `SELECT ... WHERE ${clauses.join(" AND ")} ORDER BY r.started_at DESC LIMIT ?`, args };
}

// ③ post-query 4 段 filter → predicate 表（消 JS 侧 OCP），现 :203/:206/:211/:216
type PostFilter = { transport?: string; heartbeat?: "stale" | "live"; traceId?: string };
const POST_PREDICATES: Array<(f: PostFilter) => ((i: RunItem) => boolean) | null> = [
  (f) => f.transport ? (i) => i.runnerTransport === f.transport : null,
  (f) => f.heartbeat === "stale" ? (i) => isStale(i) : null,
  (f) => f.heartbeat === "live"  ? (i) => !isStale(i) : null,
  (f) => f.traceId ? (i) => i.traceId === f.traceId : null,
];
// items = POST_PREDICATES.reduce((acc, mk) => { const p = mk(f); return p ? acc.filter(p) : acc; }, items);
```

**测试改造**：四个窄 service 各自独立测；`insights.test.ts` / `store.test.ts` 按新归类重排；`buildRunQuery` 与 post-predicate 表均可纯函数单测（断言 sql/args 或断言筛后集合）。

### 8.3 `DI#5` getSetupManager（DIP，中）

**病灶**（`main.ts:203-205`）：

```ts
// before
function getSetupManager(): LarkSetupManager {
  const provisioner = new CliSetupProvisioner();   // :205 焊死具体实现
  return new LarkSetupManager(provisioner, ...);
}
```

**做法**：

```ts
// after —— provisioner 参数注入，由组装根决定具体实现
function makeSetupManager(provisioner: SetupProvisioner): LarkSetupManager {
  return new LarkSetupManager(provisioner, ...);
}
// main.ts 顶层：makeSetupManager(new CliSetupProvisioner())
// 测试可注入 fakeProvisioner
```

### 8.4 `DI#6` createCronScheduler（DIP，中）

**病灶**（`cron/scheduler.ts:164`）：`register` 内直接 `Bun.cron(job.cronExpr, () => {...})`，绑死运行时，时间逻辑无法测。`createCronScheduler` 的 deps（`:10-18`）尚无 scheduler 抽象。

**做法**：

```ts
// ① 抽窄接口
export interface Scheduler {
  schedule(cronExpr: string, fn: () => void): CronHandle;   // CronHandle 有 stop()
}
// ② Bun 实现放外层
export const bunScheduler: Scheduler = {
  schedule: (expr, fn) => { const h = Bun.cron(expr, fn); return { stop: () => h.stop() }; },
};
// ③ createCronScheduler deps 增 scheduler: Scheduler；register 改 deps.scheduler.schedule(...)
// before (scheduler.ts:164): Bun.cron(job.cronExpr, () => { ... })
// after:                     deps.scheduler.schedule(job.cronExpr, () => { ... })
// main.ts: createCronScheduler({ ..., scheduler: bunScheduler })
```

**测试改造**：`scheduler.test.ts` 注入 `fakeScheduler`（记录注册的 expr + 暴露手动 trigger()），测单飞锁 / watchdog / retry 逻辑而不依赖真 `Bun.cron` 的真实时间。

### 8.5 `DI#7` startAgentRun 透传 wrapper（SRP/DRY，低）

**病灶**（`conv-svc-factory.ts:153-180`）：`startAgentRun` 纯透传，逐行手抄 16 字段进 `executeAgentRun`（`:156`），加字段就要全链路同步改。

**做法**：Phase 1 把 `executeAgentRun(deps, req)` 收窄成 `RunDeps`/`RunRequest`/`RunOrigin` 后，这个 wrapper 退化为：

```ts
// after —— 不再逐字段手抄；deps 在组装期已绑定，这里只补 runId + 会话 origin
export async function startAgentRun(deps: RunDeps, opts: StartAgentRunOpts) {
  return executeAgentRun(deps, {
    runId: crypto.randomUUID(),
    sessionId: opts.sessionId,
    agentId: opts.agentId,
    input: opts.input,
    origin: { kind: "conversation", conversationId: opts.conversationId, surface: opts.surface, senderName: opts.senderName },
    onAssistantMessage: opts.onAssistantMessage,
    onComplete: opts.onComplete,
  });
}
// 若调用点本就能拿到 RunDeps，可进一步删除 wrapper，直接调 executeAgentRun
```

### 8.6 `DI#8` createOrchestrator 拆分 —— 见 §7（已含完整伪代码）

---

## 8b. Phase 5 — sessionId 格式统一（PR-4）

- `issue/service.ts:72` `${issueId}:owner` → `${issueId}:${ownerAgentId}`（issue 默认 owner agent）。
- `cron/scheduler.ts:36` `${cronJobId}:owner` → `${cronJobId}:${ownerAgentId}`（job owner agent）。
- 会话（`conversation/service.ts:24` `${conversationId}:${memberId}`）与编排（`reactor.ts:122` `${issueId}:${t.agentId}`）已是 `:${agent}` 形态，无需改公式。
- 测试：`issue/service.test.ts:38/46` 断言改；`reactor.test.ts:250`（已是 `:${agentId}`，核对仍成立）；`parseThreadId`(`conversation/service.ts:30`)、`conv-svc-factory.ts:126` 前缀匹配核对。

> **关键前置：`ownerAgentId` 必须是 agent 表里真实存在的行。** 现 `:owner` 是纯字面量，不经过 agent 校验；改成 `:${ownerAgentId}` 后，这个 id 会随 sessionId 流进 `executeAgentRun`，函数体 `agentSvc.getById(agentId)`（`run-executor.ts:120`）会按它查 agent——查不到直接 throw、run 起不来。因此落地前必须先定 owner agent 的来源：要么在 setup/migration 阶段写一条保留 agent（如 `agentId = "owner"` 或 `"system-owner"`）作为种子数据，要么让 issue/cron 创建时显式指定一个已存在的 agentId。**`ownerAgentId` 不能是凭空造的字符串**，否则 PR-4 一上线 issue/cron 触发的 run 全部炸在 `getById`。种子写入点建议跟现有 setup provisioner（`main.ts:203` `getSetupManager`）走同一条初始化路径。

---

## 9. 施工顺序与依赖

```text
PR-B0  共享夹具补强（mock-deps.ts 扩 + TID + fakeSessionFactory 占位）   ← 最先，阻塞测试改造
PR-0   类型地基 + 第一批测试迁移                                         ← 依赖 B0
PR-1   executeAgentRun 重构（RunDeps/RunRequest/RunOrigin）+ 补单测      ← 依赖 PR-0，最大收益
PR-2   跨 run 持久 + factory 单测                                       ← 依赖 PR-1
PR-3   attempt→seq + 测试断言迁移                                       ← 可与 PR-2 并行
PR-4   orchestrator 拆分（DI#8）+ sessionId 格式统一（ID#5）            ← 依赖 PR-1
PR-5   周边 DI（DI#2/4/5/6/7）+ 测试可注入化                            ← 独立，可并行
```

**强链**：PR-B0 → PR-0 → PR-1 → PR-2。其余依赖 PR-0/PR-1 后可并行。

---

## 10. 测试改造的横切原则（贯穿所有 PR）

1. **不再内联手写 fake**：任何测试需要 supervisor/agentSvc/projectSvc/sessionFactory/db 替身，一律从 `apps/backend/test-helpers/mock-deps.ts` import。第三处用到就提进夹具。
2. **id 不写裸字符串**：所有测试 id 经 `TID.*` 生成，集中一处。
3. **能注入就不连真依赖**：测业务逻辑默认用 in-memory / echo 替身；只有 adapter/migration 测试才碰真 sqlite。`Bun.cron` 这类运行时绑定一律抽接口注入假实现。
4. **窄 fake**：fake 只实现被测路径真正调用的方法（学 `projectSvc.getById`），用 `Pick<>` 约束。
5. **三类 fake 各司其职**：记录型只为断言调用、数据型只为喂返回值、替身工厂造能跑的轻量真对象；不要混。
6. **每个 Phase 自带测试迁移**：生产代码改接口的同 PR 内改完对应测试，不留尾巴。§1.3 硬编码字面量逐条点名，对应 PR 必须清掉。

---

## 11. 验收总清单

生产代码（同 spec §10）：
- [ ] 面向调用方 id 入参统一 `sessionId`；executeAgentRun 无 `new` 具体实现、入参拆 `RunDeps`/`RunRequest`/`RunOrigin`；同 sessionId 复用 session；回收策略落地且 waiting 豁免；runId 透传不串号；attempt 用 `(runId,seq)`；sessionId 单一 `:${agentId}` shape；周边 DI（含 orchestrator 拆分）各 PR 落地。

测试（本 plan 新增）：
- [ ] `mock-deps.ts` 扩出 `TID / recordingSupervisor / fakeAgentSvc / fakeColumnConfigSvc / fakeDeliverableSvc / fakeProjectSvc / fakeSessionFactory / makeOrchestratorDeps / makeRunDeps`，有自测。
- [ ] 全仓测试无内联重复 `fakeSupervisor`/`fakeAgentSvc`/真磁盘 db（已收进夹具）。
- [ ] 全仓测试无硬编码 `att-r1` / `:owner` / `c:test`/`i:a`/`cr:o` / 裸 `threadId:` 字面量（改用 `TID.*` + 新格式）。
- [ ] `executeAgentRun` 与 `SessionFactory` 各有独立单测，且不依赖真实 AnthropicChatModel / 真实 sqlite。
- [ ] `scheduler.test.ts` 注入假调度器，不依赖真 `Bun.cron`。
- [ ] `createStepRunner` / `createTransitionReactor` 各自独立测，reactor.test 不再 new 真磁盘 sqlite adapter。

---

## 12. 关联

- 配套 spec `2026-06-26-identifiers-and-di-convergence.md`
- 架构页 [`foundations/identifiers.md`](../../architecture/foundations/identifiers.md)
- 架构页 [`foundations/dependency-injection.md`](../../architecture/foundations/dependency-injection.md)
