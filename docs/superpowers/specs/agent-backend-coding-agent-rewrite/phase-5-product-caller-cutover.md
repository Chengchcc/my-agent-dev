# Phase 5: 所有 Product Flow 切流到 Agent Run（破坏性切流）

## 目标

将 Product Backend 中所有真正的 Agent 执行切到统一 Agent Run creation/execution，并删除 Product Backend 的旧 Runtime 执行路径。这是唯一业务切流 Phase。

```text
Product Backend
→ durable Agent Run
→ AgentRunExecutionService
→ CodingAgentBackend
→ independent Coding Agent daemon
→ one Run / one Worker
→ BackendRunOutcome
→ backend.db atomic terminal commit
```

## 不兼容策略（非协商）

- 不保留旧路径；不保留 alias、shim、fallback、兼容 DTO 或双写。
- 不迁移旧 Runtime session/checkpoint；不继续旧 active run。
- 不增加第二套执行协调器。
- 不兼容旧 session/span API；删除旧 Web/Lark 调用方。

## 已否决概念（Phase 4 已删除或拒绝，Phase 5 禁止重建）

```text
AgentBackendRegistry
AgentBackendPool
AgentRunScopeService
AgentRunQueries
BackendSessionCache
AgentRunPool
通用 Backend manager / coordinator / RunDispatcher wrapper
scopeKey / scope table / scope registry
getOrCreateHeadless()
```

Phase 4 只支持真实 `backendKind = coding_agent`。

## 可直接使用的已存在 API

```ts
AgentRunService
  enqueueAndAcquire()
  claimNextInput()
  markInputAccepted()
  finalizeRun()
  getRun()
  getActiveRun()
  listInputs()

AgentRunExecutionService
  dispatch(runId)
  recover()
  retryTerminalCommit(runId)
  stop(runId)
  subscribe(runId, signal)

AgentContextService / AgentContextPort
ConversationService / ConversationPort
BackendSessionBinding
ProductToolsService
```

## 核心目标流程

```text
确定 Conversation + Agent Member + Context Branch
→ enqueueAndAcquire()
→ 若 acquired 则 dispatch(runId)
→ 若 queued 则等待持久 queue
→ terminal 结果由 Agent Run 和 Conversation History 表达
```

最终删除 Product Backend 对以下旧执行机制的依赖：

```text
@my-agent-team/agent
createAgentSession
Agent / AgentConfig
SessionManager / SqliteSessionManager
ConversationLock
activeSessions
member.sessionId
checkpointer.db
direct prompt/steer/followUp/compact
direct Provider/ModelRegistry Runtime assembly
```

## 关键设计决策

### 1. 不存在 Pool

所有 caller 直接依赖 `AgentRunService` + `AgentRunExecutionService`。`AgentRunExecutionService` 是唯一执行入口。

### 2. 不存在 Scope Service

scope 只由现有领域对象组成：`Conversation` + `Agent Member` + `Context Branch`。

- Conversation caller 使用已有 Conversation/Member。
- Cron、Loop 等无 UI caller 使用确定性 ID，通过现有 ports 幂等确保 Conversation、Member、default branch 存在。
- 允许少量纯 ID helper（`cronConversationId(cronJobId)`、`loopGeneratorConversationId(loopId)`、`loopEvaluatorConversationId(loopId)`），禁止状态型 scope service。

### 3. 只有真正的 Product Agent 执行才使用 Agent Run

走 Agent Run：

```text
Conversation Agent 回复
Cron Agent prompt
Loop Generator
Loop Evaluator
```

不走 Agent Run（改为 deterministic service 或删除）：

```text
Skill Pack install/sync
Conversation title 生成
普通文件/状态转换
确定性配置生成（Loop config）
```

## Wave 1 — Conversation 切流

主要文件：`conversation/service.ts`、`conversation-compose.ts`、`http.ts`、`ports.ts`、`adapter-sqlite.ts`、`*.test.ts`。

删除：

```text
conversation/lock.ts + lock.test.ts
conversation/agent-factory.ts
conversation/agent-projection.ts
conversation/run-accumulator.ts + run-accumulator.test.ts + run-accumulator.guard.test.ts
```

### 新流程

Human Message 先成为 canonical Conversation History 事实：

```text
append human Message to Conversation History
→ 根据 addressedTo / trigger rules 找到 Agent Member
→ AgentRunService.enqueueAndAcquire()
→ acquired=true 时异步 dispatch(runId)
→ queued=true 时只返回持久排队状态
```

`postMessage()` 返回真实：

```ts
{
  seq;
  triggeredRuns: Array<{
    agentMemberId: string;
    runId: string;
    queued: boolean;
  }>;
}
```

不再返回 spanId。

### normal / steer / follow_up

Product Backend 根据 branch 当前 Run 状态和输入语义写 queue：

- branch idle：normal；
- caller 明确希望影响 active Run：steer；
- active Run 结束后再处理：follow_up。

所有模式都先持久化，不直接调用内存 session 方法。禁止 `session.steer()` / `session.followUp()` / `session.prompt()` / `activeSessions` / `ConversationLock`。

若 `enqueueAndAcquire()` 返回 acquired，调用 `void agentRunExecution.dispatch(runId)`；若 queued，不直接 dispatch 不存在的新 Run。

### clear / compact

- `/clear`：操作 Product Agent Context branch（fork/move/new branch 语义）；不清理 Runtime session；不调用 SessionManager。
- `/compact`：若已有 canonical Product Context summary 策略则调用；没有则明确返回 unsupported 或保持 no-op；不调用 Coding Session compact。

### 最终 Message

Conversation 最终 assistant Message 只能由 Phase 4 terminal commit 写入。删除：

```text
streaming revision 写 Ledger
run accumulator finalization
agent projection 写 assistant Message
```

Live Updates 只供 UI 观察，不能写 History。

## Wave 2 — Conversation 旧副作用取舍

删除 `agent-projection.ts` 前逐项处理，不创建万能 `run-effects.ts`。

### Mention cascade（保留）

terminal assistant Message commit 后，对 canonical Message 文本做一次 mention 解析。实现为 Conversation 模块中的小函数（如 `findMentionedAgentMembers(message, roster)`）。对提及的 Agent Member：`enqueueAndAcquire()` → acquired 时 `dispatch()`。

必须按 final Message / runId 幂等，不能因 commit replay 触发两次。最小方案：terminal commit 后由显式回调触发，以 `sourceRunId + targetMemberId` 作为输入幂等键。

### Goal / Memory

只有仓库中已存在 canonical Product service 且明确使用者时才连接。不得为保留旧 Runtime plugin 行为新建 Goal/Memory 框架。旧行为若只存在于 Runtime plugin 事件中，删除该路径，并在最终报告列为被移除的旧 Runtime 特性。

### 删除，不兼容迁移

```text
queue_update 写 History
streaming MessageRevision 写 History
todo_update 投影
pet_bark 投影
recap_update 投影
Runtime plugin 私有事件驱动 Product 状态
```

Coding Agent 没有这些稳定核心事件，不得模拟。

### Title

本 Phase 停用自动 title，删除直接 ModelRegistry/ChatModel 调用；保留用户显式设置 title；保留现有 Conversation title API。

## Wave 3 — Cron 切流

主要文件：`cron/scheduler.ts`、`cron/*.test.ts`。

删除依赖：SessionManager / createAgentSession / ModelRegistry / ProviderAuth / direct tool/plugin assembly。

### 稳定身份

```text
conversationId = `cron:${cronJobId}`
agentMemberId  = `cron-agent:${agentId}`
```

直接通过 ConversationPort / AgentContextService：

```text
get Conversation，不存在则 createConversation
检查 Agent Member，不存在则 addMember
AgentContextService.getOrCreateDefaultBranch()
```

幂等；若现有 adapter 的 create 并发不安全，只增加必要的 insert-ignore/transaction。

### 每次 fire

```text
ensure deterministic Conversation/Member/Branch
→ enqueueAndAcquire({
    conversationId,
    agentMemberId,
    backendKind: "coding_agent",
    mode: "normal",
    message: cron prompt,
    defaultModel,
    configRevision,
    idempotencyKey: cron fire identity,
  })
→ acquired 时 dispatch(runId)
```

Cron fire 幂等键必须包含明确 fire 身份：`cronJobId + scheduledAt`，不要用随机时间值。

### timeout / retry

- timeout timer 只负责 `agentRunExecution.stop(runId)`；Run outcome/status 是唯一执行状态。
- retry 创建新 Agent Run，复用同一语义输入幂等规则。不创建 Cron attempt/run 状态机；若产品需要 retryCount，作为 Cron audit 字段。

## Wave 4 — Loop config 生成去 Agent 化

删除 `runLoopConfigGeneration()` Agent 路径。默认使用现有 `writeDefaultLoopMd()`：根据用户输入的 name/intent/project/settings 生成确定性模板。保留：创建目录、写 LOOP.md、复制固定 skill 模板、设置 cron 配置——由普通 service 完成。

禁止：

```text
Loop config Agent
Loop config Context Branch
update_loop_config Product Tool
createAgentSession
```

以后有明确"AI 解释自然语言生成复杂 Loop 配置"需求时再作为独立 Agent Run 功能新增。当前 YAGNI。

## Wave 5 — Loop Generator / Evaluator 切流

主要文件：`loop/loop-step.ts`、`loop-step.test.ts`、`loop-service.ts`、`http.ts`。

删除：AgentConfig / SessionManager / createAgentSession / BuildConfigFn / session usage 查询 / session dispose / spanId。

### 稳定身份

```text
Generator: conversationId = `loop:${loopId}:generator`
           agentMemberId  = `loop-generator:${loopId}`
Evaluator: conversationId = `loop:${loopId}:evaluator`
           agentMemberId  = `loop-evaluator:${loopId}`
```

两者独立，不共享 Context Branch。这些 Conversation/Member 只是持久执行身份和审计容器，不是额外长期 Memory 系统。

### 每个 item 执行

Generator Run 输入包含完整必要事实：item、LOOP.md generator prompt、workspace/repo path、git log、acceptance、相关 STATE。Generator 仍在配置的 workspace 中运行。

等待 Agent Run terminal status：

- completed：继续检查 git 结果；
- failed/aborted/timeout：按现有 Loop 失败策略；
- commit_failed：不继续 Evaluator。

Usage 来自 `AgentRun.terminalResult.usage`，不读 Session usage。

Generator 完成后继续确定性逻辑：git base/head、diff、denylist、rollback。

Evaluator Run 只在确定性准备完成后创建。输入包含：acceptance、files changed、diff/evidence、evaluator prompt、workspace。产物仍用现有 VERDICT.md / parseVerdictMd / PASS / REJECT / ESCALATE。Agent Run outcome 只判断执行是否完成，文件内容仍是 verdict 事实。

持久化 `generatorRunId` / `evaluatorRunId` 替代 span/session ID。不新增 Loop run coordinator。

## Wave 6 — Skill Pack install/sync 改为确定性 service

主要文件：`skill-pack/install-session.ts`、`service.ts`、`tools.ts`、`*.test.ts`。

删除：Agent / ChatModel / ContextPipeline / Plugin / progressiveSkillPlugin / createAgentSession / installer prompt。不迁移为 Agent Run。

将工具背后的确定性逻辑直接编排为普通 service：

- install git：`pending → installing → clone/fetch source → checkout versionRef → validate registry/skill structure → copy/install target → ready`
- install zip：`stage temp zip → unzip safely → validate → install → cleanup temp file → ready`
- sync：`ready → syncing → fetch/update source → validate → replace atomically → ready`
- 失败：`status → failed`、error 持久化、临时文件清理。

复用现有 ports/fs adapters/helper 函数。保留安全边界：zip path traversal 防护、source validation、temp cleanup、状态转换、幂等/retry 行为。

## Wave 7 — Bootstrap 删除旧 Runtime composition

主要文件：`bootstrap/services.ts`、`services.test.ts`、`features.ts`、`features.test.ts`、`main.ts`、`features/agent/agent-compose.ts`、`features/agent/service.ts`、`apps/backend/package.json`。

删除：SqliteSessionManager / SessionManager / checkpointer.db / ModelRegistry / ProviderAuth for Product execution / createDefaultModelRegistry / direct defaultTools/defaultPlugins/defaultContextManager / supervisor→sessionManager disposal wiring / old resume route。

Phase 4 已在 `installFeatures()` 构造：AgentRunService、AgentRunExecutionService、ProductToolsService、Product Tools MCP、CodingAgentBackend。保留并注入到 Conversation/Cron/Loop。

### Agent 删除

`AgentService.hardDelete()` 的 busy guard 改为查询：是否存在该 agentId 对应的 active Agent Run。不要通过 session IDs 查询。旧 checkpointer 数据直接废弃，删除相关 hook，不迁移。

## Wave 8 — 最小 Agent Run API 与 Ops 切流

最低交付：

```text
GET  /api/agent-runs
GET  /api/agent-runs/:runId
POST /api/agent-runs/:runId/cancel
GET  /api/agent-runs/:runId/events
```

数据源：`agent_run`、`branch_input_queue`、`BackendSessionBinding`、`AgentRunExecutionService.subscribe`。

状态：`running` / `waiting` / `commit_failed` / `completed` / `failed` / `aborted` / `timeout`。

cancel：`agentRunExecution.stop(runId)`。

删除旧：span/session resume endpoint、session list/detail、checkpoint event terminal inference、heartbeat recovery 作为 Product 状态。

Span/attempt/control-plane 数据若仍有非 Product 使用，可以暂留为 audit，但不得决定 Run terminal。高级 Ops 功能延后：复杂 insights、attempt 树 UI、root-cause 聚合、历史 checkpoint 事件分析。不为保留旧页面设计兼容 Agent Run DTO。

## Wave 9 — Web Conversation 切流

目标：

```text
canonicalMessages 来自 Conversation History
transient 状态来自 Agent Run Live Updates
Agent Run status 决定 busy/waiting/failed
```

Backend 提供两类事实：

1. Conversation History SSE：canonical Messages、可重放、final assistant Message 只在 terminal commit 后出现。
2. Agent Run Live Updates：text/thinking/tool/status、transient、断线可丢、不进入 Message reducer canonical state。

Web hook 内部暴露简单视图：

```ts
{
  canonicalMessages;
  activeRun;
  transientText;
  transientTools;
}
```

不创建通用 stream reconciler service。当对应 Run 的 canonical final Message 进入 History，清理该 Run transient state。

删除旧：streaming MessageRevision 作为 canonical Message、spanId/sessionId 决定 busy、approval resume 旧 endpoint、session stop/recover 客户端。`backend.coding_agent.*` 事件只能用于诊断/增强 UI，不能改变 Product 状态。

## Wave 10 — Lark 切流

Lark final delivery 只依赖 Conversation History canonical Message。Transient updates 可选：可临时编辑"正在思考"消息；断线不影响 final 交付；不把 transient 内容标记为已完成；不按 span/session 做 final 幂等。

Final delivery 幂等使用 canonical Message 身份。Worker crash / Run failed 可显示状态提示，但不能伪造 assistant final Message。

## Wave 11 — 删除旧 Span/Runtime 路径

删除或修改：

```text
apps/backend/src/features/span/agent-helpers.ts
apps/backend/src/features/span/session-manager.test.ts
apps/backend/src/features/span/http.ts + http.test.ts
apps/backend/src/features/runtime-ops/checkpoint-events-store.ts + test
apps/backend/test-helpers/mock-span.ts
```

SpanSupervisor 若只服务旧 Agent 执行，删除。若仍用于非 Agent audit，只保留不依赖 `@my-agent-team/agent` / SessionManager / CheckpointEvent 的部分。

删除 Backend package 依赖中不再使用的：`@my-agent-team/agent`、旧 runtime plugins、旧 ModelRegistry 相关依赖。不删除仓库级 packages（Phase 6 处理）。

## 行为迁移原则

### 不迁移旧 Runtime 特有行为

明确删除：

```text
streaming revision 写 History
queue_update 写 History
todo_update 自动投影
pet_bark 自动投影
recap_update 自动投影
old checkpoint resume
session recovery
```

以后若需要，基于新的稳定 Product 事件或 Product Tool 重新设计，不保留旧 plugin 事件解释器。

### 不双写

任何时刻只允许一个 final assistant Message 写入路径：Phase 4 terminal commit。旧 agent-projection、run-accumulator 不得继续写。

### 不兼容旧 API

删除旧 session/span 执行 API 及 Web/Lark 调用方。不返回旧字段的兼容对象。

## 测试策略

不要把所有旧 SessionManager test 机械翻译成 Agent Run mock。测试真实 Product contract。

- **Conversation**：Human Message 先写 History；Agent Run 创建/排队；busy 输入持久化；restart 后顺序保持；final Message 在 terminal commit 前不可见、commit 后恰好一条；mention cascade 按 final Message 且幂等；无 ConversationLock/activeSessions。
- **Cron**：同 cronJob 重启后使用同一 Conversation/Member/Branch；fire 创建 Agent Run；overlap 保持单 active Run；timeout 调用 stop；retry 新建 Run 不重复语义输入；无 SessionManager/model assembly。
- **Loop**：config 创建无需 Agent；Generator/Evaluator 独立确定性身份；每个 item 记录 runId；usage 从 terminal result 读取；failed/timeout/crash 不继续错误阶段；denylist 和 git rollback 保持确定性；无 Agent/AgentConfig/SessionManager mock。
- **Skill Pack**：git install、zip install、sync、retry、path traversal、temp cleanup、transition 到 ready/failed；无模型或 Agent Run 调用。
- **Surface**：transient disconnect 不影响 canonical final；final Message 不重复；failed Run 不显示成功；private Backend 事件不改变 Product state；cancel 使用 runId。

## Clean gate（必须全部为零）

```bash
! grep -R '@my-agent-team/agent' apps/backend --include='*.ts' --include='package.json'
! grep -R -E 'createAgentSession|SessionManager|SqliteSessionManager|ConversationLock|activeSessions|member\.sessionId|resumeRoutes' apps/backend --include='*.ts'
! grep -R -E '\.(prompt|steer|followUp|compact)\(' apps/backend/src --include='*.ts'
! grep -R 'checkpointer\.db' apps/backend/src --include='*.ts'
! grep -R -E 'client\.api\.ops\.sessions|useOpsSession|spanId.*resume|resumeRun' apps/web apps/lark-bot --include='*.ts' --include='*.tsx'
```

注意：不要通过修改 grep 规避失败，修正真实 owner。

## 执行顺序

严格按此顺序，避免半迁移状态：

```text
1. Conversation
2. Cron
3. Loop config 去 Agent 化
4. Loop Generator/Evaluator
5. Skill Pack deterministic 化
6. Bootstrap 删除 Runtime
7. Agent Run API/Ops 最小切流
8. Web
9. Lark
10. 静态清理与全仓门禁
```

每完成一个 caller，立即删除它的旧执行路径，不保留双路由。

## 验证命令

```bash
bun install --frozen-lockfile
bun test apps/backend/src/features/conversation
bun test apps/backend/src/features/cron
bun test apps/backend/src/features/loop
bun test apps/backend/src/features/skill-pack
bun test apps/backend/src/features/agent-run
bun test apps/backend/src/features/product-tools
bun test apps/backend/src/bootstrap
bun test apps/backend/src/features/runtime-ops
bun run --cwd apps/backend typecheck
bun run --cwd apps/backend lint
bun test packages/api-contract
bun run --cwd apps/web typecheck
bun run --cwd apps/web lint
bun run --cwd apps/lark-bot typecheck
bun run --cwd apps/lark-bot lint
bun run build
bun run typecheck
bun run test
```

全量测试顺序执行，避免共享 /tmp 造成并行假失败。

## 完成标准

只有以下全部成立才宣布 Phase 5 完成：

```text
Conversation 只通过 Agent Run 执行
Cron 只通过 Agent Run 执行
Loop Generator/Evaluator 只通过 Agent Run 执行
Loop config 生成不依赖 Agent
Skill Pack install/sync 不依赖 Agent 或模型
所有 final assistant Message 只由 terminal commit 写入
normal/steer/follow_up 均先持久化
busy queue 在 restart 后保持顺序
Web 只用 canonical History + transient updates
Lark final 只来自 canonical History
Ops 只以 Agent Run 为 Product 执行身份
Backend 无 SessionManager/createAgentSession/ConversationLock
Backend 无 checkpointer.db 产品依赖
apps/backend 不依赖 @my-agent-team/agent
无兼容层、fallback 或双写
全仓 build/typecheck/test/lint 恢复绿色
```

## 最终报告要求

1. 每个 caller 的新执行流程；
2. 被删除的旧 Runtime 文件；
3. 被判定为非 Agent 并改为 deterministic service 的功能；
4. Conversation final Message 唯一写入点；
5. normal/steer/follow_up 的持久 queue 行为；
6. Web/Lark transient 与 canonical 分离；
7. Ops 新 API 和删除的旧 API；
8. 静态 clean gate 结果；
9. 所有验证命令与真实输出；
10. 仍存在的明确 ceiling。

## 完成记录（2026-08-04）

Phase 5 已实施完毕，所有验收标准通过：

- Conversation、Cron、Loop Generator/Evaluator 只通过 `AgentRunService` + `AgentRunExecutionService` 执行；Loop config 与 Skill Pack 为确定性 service；自动 title 停用。
- 所有 final assistant Message 只由 Phase 4 terminal commit 写入（`commitCompletedRun`）。
- normal/steer/follow_up 全部先持久化（`branch_input_queue`，rowid 排序），restart 后顺序保持。
- Web 只用 canonical Conversation History + transient Agent Run Live Updates；Lark final 只来自 canonical History。
- Ops 以 Agent Run 为唯一执行身份（`/api/agent-runs` list/detail/cancel/events）。
- `apps/backend` 零 `@my-agent-team/agent` 依赖，无 SessionManager/createAgentSession/ConversationLock/checkpointer.db。
- 删除的旧 Runtime 文件与包见实施记录；无兼容层、fallback 或双写。
- 全仓 build / typecheck / test / lint 恢复绿色。
