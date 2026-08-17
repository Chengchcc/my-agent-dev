# Remove Runner & AgentFS, Integrate AgentSession

**Status**: grill complete → spec updated
**Date**: 2026-06-25
**Scope**: packages/harness, packages/framework, apps/backend, apps/web

---

## 1. Motivation

**Runner 是伪需求。** RunnerDaemon + RunnerProtocol + RunnerRegistry + RunSupervisor
的 transport 路由构成独立进程+消息协议的控制面。Agent 不需要独立进程——backend
跑在容器里（Docker/k8s），bash 直接 exec。

**AgentFS 是间接层。** sharedRoot/privateRoot/posixRoots/mounts 被 6 个包依赖，但
工具的 workspace 就是进程 cwd。Pi 直接用真实文件系统。

**AgentSession 是缺失的编排层。** Pi 的 `AgentSession` 把 Agent + Checkpointer +
PluginRunner + ContextManager 组成为有清晰生命周期的单元。当前这些职责分散在
createGenericAgent、RunnerDaemon、RunSupervisor 三处。

---

## 2. Design decisions (grilled)

| # | 决策 | 理由 |
|---|------|------|
| 1 | **不加 SessionStore** | 设计哲学原则 1+2——Checkpointer 已存 messages，SessionStore 会复制语义。Checkpointer 是唯一持久化机制 |
| 2 | **Checkpointer.db 全局合并** | 单个 `dataDir/checkpointer.db`，按 threadId 分区存所有 agent 的线程 |
| 3 | **Agent 加 subscribe()** | 不改 generator 模式，Agent 同时支持 subscribe 和 generator 两个输出 |
| 4 | **bootstrap → identityPlugin** | 读 cwd 下的 SOUL/USER/TOOLS/AGENTS + memory 日志，beforeModel 注入 XML 格式系统提示。保留 genesis 逻辑（BOOTSTRAP.md 出生模式） |
| 5 | **Compaction 纯内存+LLM 操作** | 读 checkpointer.load()→summarize→写 system message→checkpointer.save()。不依赖外部接口 |
| 6 | **Workspace 单层目录** | `dataDir/agents/{id}/` — SOUL.md/USER.md/memory/ 直接在这个目录下。去掉 shared/private/state 三层。工具 cwd 就是这个目录 |
| 7 | **框架层不变** | createAgent / plugins / contextManager / checkpointer 接口保持原样 |
| 8 | **summarizingContextManager → autoSummarize** | 框架层改名避免混淆。AgentSession.compact() 是 session 层 reactive 操作，autoSummarize 是 contextManager 管道里的自动预防 |
| 9 | **Conversation 作为 plugin** | ConversationContextPlugin: beforeRun 注入成员+上下文，提供工具让 agent 渐进式加载历史 |
| 10 | **AgentSession 生命周期 = 一次 Run** | 不存在"池"——每次 dispatch 创建新 AgentSession，run 结束 dispose |
| 11 | **3-Phase 迁移** | Phase 1 只加不删（新旧 API 共存），Phase 2 切换 backend + 前端，Phase 3 全量删除 |
| 12 | **Reflection 保持独立 run** | 删除 runner-daemon 的 `#fireReflect`。Backend 在 main run 成功后 fire-and-forget 创建新的 AgentSession（threadId=`reflect:...`）。AgentSession 不感知 reflection |
| 13 | **retry/compaction 不新增 SSE 事件** | 在 `MessageRevision` 加 `runStatus` 字段。前端从 message action 推导，不需要新 reducer action。AgentSessionEvent 仍保留 retry/compaction 事件给 backend listener（ops 日志） |
| 14 | **Conversation 工具 surface-agnostic** | 四个通用工具（read_history/read_context/search/members）都读 ledger，不区分 surface。Surface 差异仅在系统提示和 surface 专属工具（如 Lark 的 `start_new_conversation`） |
| 15 | **Backend 拥有 plugin 实现** | Plugin 不依赖 backend，只接收 `Tool[]` + `systemPrompt`。Backend 创建工具（闭包持有 convPort）并组装 plugin。依赖方向：backend → plugin |
| 16 | **ThreadProjection 整块删除** | 确认死代码。读路径无 HTTP 路由，写路径无人消费。删除 `apps/backend/src/features/thread-projection/` 全部 6 个文件 |
| 17 | **conversation 包瘦身** | 保留领域类型（LedgerEntry/Member/Conversation/resolveTriggerTargets）。移除 `projectForMember`（移到 backend）。移除对 `@chengchenccc/message` 的 re-export |
| 18 | **forkRun → startAgentRun** | 命名修正。input 是触发消息文本（不再是空串）。跟直接调用的区别只在于是否挂 ConversationContextPlugin——都在一个 conversation 里就挂 |
| 19 | **Checkpointer 不迁移 + deleteThread** | 合并到全局 `checkpointer.db`，不迁移旧数据（checkpointer 是运行时恢复状态，canonical 在 ledger）。新增 `deleteThread(threadId)` 方法 |
| 20 | **Issue/Cron 都是 conversation** | Issue 创建时自动建 conversation（`conversationId = issueId`），cron 同理。Agent 输出走 ledger → SSE → 前端。不需要 ConversationContextPlugin（无多人对话） |
| 22 | **BOOTSTRAP_TEMPLATE 不写磁盘** | identityPlugin 完全拥有 genesis。backend 不再写 BOOTSTRAP.md 文件，`workspace.ts` 不再 import harness。identityPlugin 检测到无 SOUL.md 时在系统提示中注入 BOOTSTRAP_TEMPLATE |
| 23 | **workspace.ts 保留** | 非 runner-specific（`workspaceRoot/{agentId}/` 单层布局）。Phase 2 切换后继续使用 |
| 24 | **Dispatcher 删除** | 薄包装器（insertRunOrigin + startMainRun）。重构后 opsStore 调用保留，startMainRun 变为 startAgentRun |
| 25 | **所有 run 都写 conversation** | Conversation/orchestrator/cron 三路都调 `appendAssistantMessage` 写 ledger → SSE → 前端。区分只在 `agent_end` 的后续逻辑 |
| 26 | **onEvent 回调模式** | `startAgentRun` 接收 `onEvent` 回调。AgentSession 发射事件，调用方决定如何处理——conversation 写 ledger + @mention，orchestrator 推进状态机，cron 标记完成 |
| 27 | **Resume 跨 prompt/resume** | AgentSession.prompt() 返回时可能中断。Backend 维护 `Map<runId, AgentSession>`。resume 时通过 runId 查找 session，调 `session.resume(cmd)`。agent_end（非中断）才 dispose |
| 28 | **afs-tools → file-tools** | `withWorkspace` 简化为 `withDefaultCwd(tool, cwd)`。新增 `createReadTool({cwd})` 等。旧 API 保留至 Phase 3 |
| 29 | **attempt.pid/heartbeat_at 孤儿列** | 不写新值，保留 nullable。`runner_health` 表变死数据——Phase 3 清理 |
| 30 | **Lark bot 零影响** | SSE watcher / surface.control / ingest 都不依赖 runner。`safeAgentId` 函数保留，注释清理 |

---

## 3. What gets deleted (Phase 3)

```
packages/runner-protocol/          — 整包
packages/runner-daemon/            — 整包
packages/agent-fs/                 — 整包
packages/harness/src/create-generic-agent.ts
packages/harness/src/bootstrap.ts  (旧版, AgentFS 依赖)
packages/harness/src/reflect.ts    (reflectionGuidance 移到 compaction.ts)
packages/core/src/agent-fs.ts      (AgentFsLike 接口)
packages/tools-common/src/sandbox.ts (AgentFsRoots, withWorkspace, SandboxError)
packages/tools-common/src/agent-fs-like.ts
apps/backend/src/features/run/runner-registry.ts
apps/backend/src/features/run/runner-registry-factory.ts
apps/backend/src/infra/runner-workspace.ts
apps/backend/src/features/conversation/projection.ts:buildPreloadedMessages() — 删除
apps/backend/src/features/conversation/conv-svc-factory.ts:buildAgentSpecV2() — 删除
apps/backend/src/features/thread-projection/ — 全部 6 个文件（死代码）
packages/conversation/src/projection.ts — projectForMember 移到 backend
```

## 4. What gets added (Phase 1)

```
packages/harness/src/agent-session.ts            — AgentSession 类
packages/harness/src/compaction.ts               — compaction 纯函数 + reflectionGuidance 常量
packages/harness/src/plugins/identity-plugin.ts   — identityPlugin
```

## 5. What gets modified

### 5.1 packages/framework (Phase 1)
- Agent 加 `subscribe(listener): () => void`
- `summarizingContextManager` → `autoSummarize`（改名）
- 内部 emit 时同时通知 subscribers + yield

### 5.2 packages/core (Phase 1 保留, Phase 3 删)
- Phase 3: 删除 `AgentFsLike` 接口和 `pjoin` helper

### 5.3 packages/tools-common (Phase 1 加新, Phase 3 删旧)
- Phase 1: 新增 cwd 版本的工具工厂（`createReadTool`, `createWriteTool` 等，接受 `cwd: string`）
- Phase 1: 旧 API 保留（`withWorkspace`, `AgentFsRoots`）
- Phase 3: 删除旧 API 和 sandbox.ts、agent-fs-like.ts

### 5.4 packages/harness (Phase 1 加新, Phase 3 删旧)
- Phase 1: 新增 `agent-session.ts`, `compaction.ts`, `plugins/identity-plugin.ts`
- Phase 1: `index.ts` 新增导出，旧导出保持
- Phase 3: 删除 `create-generic-agent.ts`, `bootstrap.ts`, `reflect.ts`

### 5.5 apps/backend (Phase 2)
- `main.ts`: 删 RunnerRegistry + Supervisor(transport) + Dispatcher。AgentSession 管理。删 `threadProjectionRoutes`
- `features/run/supervisor.ts`: 降级为 RunLifecycleTracker (run/attempt 行 + reaper)，删 transport 路由
- `features/run/dispatcher.ts`: 删 `transport.send("start")`，改为直接调 `AgentSession.prompt()`
- `features/run/service.ts`: 改为调 AgentSession
- `features/conversation/conv-tools.ts`: **新增**——5 个 conversation 工具（闭包持有 convPort）
- `features/conversation/conv-svc-factory.ts`: forkRun 闭包重写——删 `buildAgentSpecV2`/`buildPreloadedMessages`，改用 ConversationContextPlugin
- `features/conversation/projection.ts`: 删 `buildPreloadedMessages()`。`projectForMember` 保留（`broadcastMessage` 仍然需要它做 member 视角投影）
- `features/conversation/service.ts`: `broadcastMessage` 删 `threadProjectionWrite.appendMessages` 调用
- `features/thread-projection/`: **整目录删除**（死代码）
- `features/agent/agent-svc-factory.ts`: `materializeRunnerWorkspace` → `mkdir agents/{id}`
- `features/agent/identity-store.ts`: runner workspace paths → agents/{id} 路径
- `features/orchestrator/reactor.ts`: dispatch 改为调 AgentSession
- `features/cron/scheduler.ts`: dispatch 改为调 AgentSession
- `http/router.ts`: 删 `threadProjections` FeatureSet 字段

### 5.6 Other packages (Phase 1)
- `plugin-fs-memory`: `AgentFsLike` → `cwd + /memory/` 路径
- `plugin-progressive-skill`: `AgentFsLike` → `cwd + /skills/` 路径
- `runtime-observability`: 删 `"runner-daemon"` serviceName，删 runner 相关 span names，删 `"runner.transport"` attribute

---

## 6. AgentSession interface

### 6.1 Configuration

```typescript
interface AgentSessionConfig {
  // framework 透传
  model: ChatModel;
  threadId?: string;
  tools?: Tool[];
  plugins?: Plugin[];
  checkpointer?: Checkpointer;
  contextManager?: ContextManager;
  logger?: Logger;

  // session 层
  cwd: string;                    // agent 工作目录
  systemPrompt: string;           // backend 传入少量基础 prompt，插件通过 beforeModel 扩展
  thinkingLevel?: ThinkingLevel;
  maxSteps?: number;

  // 自动维护
  retry?: RetrySettings;
  compaction?: CompactionSettings;
}
```

### 6.2 Methods

```typescript
interface AgentSession {
  // ── 生命周期 ──
  prompt(text: string, opts?: { signal?: AbortSignal }): Promise<void>;
  continue(opts?: { signal?: AbortSignal }): Promise<void>;
  resume(cmd: ResumeCommand, opts?: { signal?: AbortSignal }): Promise<void>;
  abort(): void;
  waitForIdle(): Promise<void>;
  dispose(): void;

  // ── 运行中干预 ──
  steer(text: string): void;
  followUp(text: string): void;

  // ── 配置 ──
  setModel(model: ChatModel): void;
  setThinkingLevel(level: ThinkingLevel): void;
  setActiveTools(toolNames: string[]): void;
  getAllTools(): ToolInfo[];

  // ── 维护 ──
  compact(customInstructions?: string): Promise<CompactionResult>;
  getContextUsage(): ContextUsage | undefined;

  // ── 事件 ──
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;

  // ── 只读状态 ──
  readonly isStreaming: boolean;
  readonly state: AgentState;
}
```

### 6.3 Events (backend listener)

```typescript
type AgentSessionEvent =
  // ── 透传 AgentEvent (agent_end 增强) ──
  | Exclude<AgentEvent, { type: "agent_end" }>
  | { type: "agent_end"; messages: Message[]; willRetry: boolean }

  // ── 队列状态 ──
  | { type: "queue_update"; steering: string[]; followUp: string[] }

  // ── 维护生命周期 (backend ops 日志用) ──
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | { type: "compaction_end";
      reason: "manual" | "threshold" | "overflow";
      result?: CompactionResult;
      aborted: boolean;
      willRetry: boolean;
      errorMessage?: string; }

  // ── 自动重试 (backend ops 日志用) ──
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string };
```

注：不包含 `thinking_level_changed` 和 `model_changed`——这些信息从 `agent.state` 读取。

### 6.4 MessageRevision.runStatus (前端用，不走新 SSE)

retry/compaction 的瞬态状态不新增 SSE 事件类型——在 `MessageRevision` 上加字段：

```typescript
// packages/message 的 MessageRevision 新增
runStatus?: "running" | "retrying" | "compacting" | "waiting";
```

AgentSession 在 retry/compaction 时更新 `agent.state.currentMessage.runStatus`。
前端 `message` SSE 事件携带 `runStatus`，reducer 在现有 `message` action 中处理。
`ConversationCanvas` / `MessageBubble` 从 message 的 `runStatus` 推导 UI 指示器。

---

## 7. AgentSession internal structure

### 7.1 Construction

```
AgentSession(config)
  → createAgent({ model, threadId, tools, plugins, checkpointer, contextManager, logger, systemPrompt })
  → agent.subscribe(this.#handleEvent)
  → 初始化 steer/followUp 队列 + retry/compaction 状态
```

### 7.2 prompt() flow

```
prompt(text, opts?)
  ├── 流式中(agent is streaming)? → steer/followUp 队列 → return
  └── 非流式 → #runAgentPrompt(messages)
      ├── agent.prompt(messages)
      ├── while (#postRunNeedsContinue)
      │   ├── retryable error? → backoff → agent.continue()
      │   │   └── 设置 agent.state.currentMessage.runStatus = "retrying"
      │   ├── overflow? → compact() → agent.continue()
      │   │   └── 设置 agent.state.currentMessage.runStatus = "compacting"
      │   ├── threshold? → compact() → return
      │   └── queued messages? → agent.continue()
      └── return
```

注：post-run 不包含 reflection。Reflection 由 backend 在外部 fire-and-forget 编排（见 §13）。

### 7.3 Internal subscriber (#handleEvent)

```
#handleEvent(event: AgentEvent)
  ├── message_start/user → 检测队列并移除
  ├── message_end → 通知外部 listeners
  │   ├── assistant → 记录 #lastAssistantMessage
  │   └── terminal → 检查 retry/compaction
  ├── agent_end → 包装 willRetry → emit
  └── tool_execution_* → 透传
```

### 7.4 compact()

```
compact(customInstructions?)
  → checkpointer.load(threadId) → messages
  → 计算 context usage，找 compaction boundary
  → LLM summarize(messages[0..N-10])
  → summaryMessage = { role: "user", text: "[Earlier summary]: ..." }
  → thread.messages = [summaryMessage, ...messages[N-10:]]
  → checkpointer.save(threadId, thread.messages)
  → agent.state.messages = thread.messages
  → emit compaction_end
```

### 7.5 Error handling

| 场景 | 行为 |
|------|------|
| compact() 中 LLM 调用失败 | 返回原 messages，日志告警，不压缩 |
| retry 耗尽（3次） | agent_end with error + `willRetry: false` |
| prompt() 期间 abort | agent.abort() → post-run 跳过 |
| overflow → compact → 再次 overflow | 告警，"Try a larger-context model" |
| compact 执行中 agent 继续写 | compact 暂停 agent（abort current run），压缩完 rebuild context，continue |
| steer/followUp 在 retry 期间 | 保留在队列，retry 成功后注入 |

---

## 8. Framework change: Agent.subscribe()

```typescript
// packages/framework/src/agent-options.ts
interface Agent {
  thread: Thread;
  run(input, opts?): AsyncIterable<AgentEvent>;
  continue(opts?): AsyncIterable<AgentEvent>;
  resume(cmd, opts?): AsyncIterable<AgentEvent>;
  fork(msgs?, id?): Agent;

  // NEW
  subscribe(listener: (event: AgentEvent) => void): () => void;
}
```

实现：`createAgentInternal` 维护 `Set<AgentEventListener>`，emit 时先通知 subscribers 再 yield。

---

## 9. identityPlugin

```
identityPlugin({ cwd: string }): Plugin
```

**beforeModel hook:**
1. 读 `{cwd}/BOOTSTRAP.md` — 存在且 `{cwd}/SOUL.md` 为空 → 返回 BOOTSTRAP_TEMPLATE（genesis 模式）
2. 并行读 6 个文件：SOUL.md、USER.md、TOOLS.md、AGENTS.md、`memory/{today}.md`、`memory/{yesterday}.md`
3. 全部为空 → 返回 BOOTSTRAP_TEMPLATE
4. `composeSystemPrompt()` 拼成 XML → 作为系统提示前缀

**工具（无需注册）：** identityPlugin 不注册工具。文件操作通过 read/write 工具完成。

---

## 10. ConversationContextPlugin

**依赖方向：backend → plugin（不反过来）。** Plugin 只接收组装好的 `Tool[]` 和 `systemPrompt` 字符串，不持有 `convPort` 或任何 backend 类型。

```
ConversationContextPlugin({ tools: Tool[], systemPrompt: string }): Plugin
```

### 10.1 Backend 创建工具和提示

```typescript
// apps/backend/features/conversation/conv-tools.ts (新文件)

// 闭包持有 convPort，不暴露给 plugin
function createReadHistoryTool({ convPort, conversationId }): Tool;
function createReadContextTool({ convPort, conversationId }): Tool;
function createSearchTool({ convPort, conversationId }): Tool;        // 本地 DB 搜索，非 LLM
function createListMembersTool({ convPort, conversationId }): Tool;
function createStartNewConversationTool({ convPort, convSvc, conversationId }): Tool; // 仅 lark
```

```typescript
// conv-svc-factory.ts 重构后的 forkRun
const convTools = [
  createReadHistoryTool({ convPort, conversationId }),
  createReadContextTool({ convPort, conversationId }),
  createSearchTool({ convPort, conversationId }),
  createListMembersTool({ convPort, conversationId }),
  ...(surface === "lark" ? [createStartNewConversationTool({ convPort, convSvc, conversationId })] : []),
];

const systemPrompt = `<conversation>
  <surface>${surface}</surface>
  <title>${title}</title>
  <trigger>
    <from>${senderName}</from>
    <message>${triggeringMessage}</message>
  </trigger>
</conversation>
如需更多上下文，使用 read_conversation_history 等工具。`;

const plugin = ConversationContextPlugin({ tools: convTools, systemPrompt });
```

### 10.2 Plugin 定义

```
ConversationContextPlugin({ tools, systemPrompt }):
  → 注册 tools（所有 surface 共享 + surface 专属）
  → beforeModel: 将 systemPrompt 追加到 messages
```

### 10.3 工具清单

| 工具 | 所有 surface | 行为 |
|------|-------------|------|
| `read_conversation_history` | ✅ | 读 ledger，倒序返回最近 N 条 message entry |
| `read_message_context` | ✅ | 围绕指定 messageId 返回前后各 N 条 |
| `search_conversation` | ✅ | 本地全文搜索 ledger entries |
| `list_members` | ✅ | 返回成员列表（name + kind: agent/human） |
| `start_new_conversation` | 仅 `lark` | 创建新 conversation，写 `surface.control` entry |

### 10.4 删掉的旧行为

- `buildPreloadedMessages()` 不再调用——不再一次性灌入全部历史
- `forkRun` 不再传 `preloadedMessages`
- `broadcastMessage` 不再调 `threadProjectionWrite.appendMessages`

---

## 11. Workspace directory layout

```
OLD (runner):
  dataDir/runners/{agentId}/
    ├── shared/          ← SOUL.md, USER.md, memory/
    ├── private/         ← 工具工作区
    ├── state/           ← checkpointer.db
    ├── runner.sock
    └── runner.pid

NEW:
  dataDir/agents/{agentId}/
    ├── SOUL.md, USER.md, BOOTSTRAP.md, TOOLS.md, AGENTS.md
    ├── memory/           ← {date}.md, MEMORY.md, facts/*.md
    └── ...               ← 工具读写都在此目录

  dataDir/checkpointer.db  ← 全局，按 threadId 分区
```

---

## 12. Backend integration

### 12.1 startAgentRun (formerly forkRun)

```typescript
// 命名: forkRun → startAgentRun (不涉及 "fork"，就是启动 agent 的 run)
// input: 触发消息文本（不再是空串——没有了 preloaded 全量历史）

startAgentRun(threadId, agentId, input, { conversationId, convPort, surface?, memberId? }):
  agent = await agentSvc.getById(agentId)

  // 有 conversation 上下文 → 挂 ConversationContextPlugin
  convTools = conversationId ? buildConvTools({ convPort, convSvc, conversationId, surface }) : []
  convPrompt = conversationId ? buildConvPrompt({ surface, senderName, triggeringMessage: input }) : ""
  plugins = [
    identityPlugin({ cwd: agentsDir(agentId) }),
    ...(conversationId ? [ConversationContextPlugin({ tools: convTools, systemPrompt: convPrompt })] : []),
    fsMemoryPlugin({ cwd: agentsDir(agentId) }),
    progressiveSkillPlugin({ cwd: agentsDir(agentId) }),
    taskGuardPlugin({ model }),
  ]

  session = new AgentSession({ threadId, plugins, model, checkpointer, ... })
  await session.prompt(input)
  session.dispose()
```

### 12.2 HTTP SSE

```
session.subscribe(event → backend handler)
  ├── AgentEvent "message" → ledger write → broadcast → SSE "message" (包含 runStatus)
  └── AgentSessionEvent "auto_retry_*" / "compaction_*" → opsStore.appendRunEvent()
```

### 12.3 Reflection (fire-and-forget)

```
onMainRunComplete(runId, threadId, status):
  if (status !== "succeeded") return
  void (async () => {
    const session = new AgentSession({
      threadId: `reflect:${threadId}`,   // 隔离 thread
      plugins: [identityPlugin, fsMemoryPlugin],  // 只需要 identity + memory
      systemPrompt: reflectionGuidance(),           // 从 harness 导入
      // 不需要 ConversationContextPlugin
    })
    try { await session.prompt(reflectionGuidance()) } catch { /* best-effort */ }
    session.dispose()
  })()
```

AgentSession 本身不感知 reflection。`reflectionGuidance` 从 `packages/harness/src/compaction.ts` 导出（常量）。

---

## 13. Event flow change

### 13.1 Current (runner)

```
前端 postMessage()
  → convSvc.postMessage()
    → forkRun() → buildAgentSpecV2 → dispatcher.dispatch()
      → supervisor.startMainRun() → transport.send("start")
        → runner-daemon → Agent.run()
          → for await (event) transport.send("event", { event })
            → supervisor.handleRunnerMessage()
              → onRunMessage → convSvc.broadcastMessage()  → SSE "message"    ← 前端消费
              → onRunEvent  → manual parse todo_update      → SSE "todo"       ← 前端消费
```

### 13.2 New (AgentSession)

```
前端 postMessage()
  → convSvc.postMessage()                    ← 不变
    → 创建 AgentSession                      ← 替代 forkRun + dispatcher
      → ConversationContextPlugin (beforeRun) ← 注入上下文 + 工具（不灌全部历史）
      → AgentSession.prompt(input)
        → session.subscribe(backend handler)  ← 替代 supervisor 路由
          → AgentEvent "message" → ledger write → SSE "message"     ← 包含 runStatus
          → AgentSessionEvent "auto_retry_*" → opsStore 日志       ← 不进 SSE
          → AgentSessionEvent "compaction_*" → opsStore 日志       ← 不进 SSE

Main run 完成:
  → backend fire-and-forget reflection run    ← 替代 runner-daemon #fireReflect
    → threadId = "reflect:{originalThreadId}"
```

### 13.3 SSE 事件对比

| 事件 | 当前 | 重构后 | 前端 |
|------|------|--------|------|
| `message` | SSE "message" | SSE "message"（格式不变，新增 `runStatus` 字段） | ✅ `message` action 处理 |
| `todo` | SSE "todo"（手动解析） | SSE "todo"（ConversationContextPlugin 解析） | ✅ 不变 |
| `member.joined/left` | SSE | SSE（不变） | ✅ 不变 |
| retry 状态 | 不存在 | `MessageRevision.runStatus = "retrying"` | ✅ 从 message 推导 |
| compaction 状态 | 不存在 | `MessageRevision.runStatus = "compacting"` | ✅ 从 message 推导 |

**不新增 SSE event type。** 前端只加一个字段处理，不加新 reducer action。

---

## 14. Frontend impact

### 14.1 Chat flow — minimal change

**`MessageRevision` 新增字段：**
```typescript
runStatus?: "running" | "retrying" | "compacting" | "waiting";
```

**`apps/web/src/lib/conversation-reducer.ts`:**
- `message` action 已解析 `MessageRevision`，`runStatus` 字段自动可用——不需要新 action
- `isBusy()` 不变（从 message state 推导）

**`apps/web/src/hooks/useConversation.ts`:**
- 不新增 addEventListener——`runStatus` 通过现有的 `message` SSE 事件传递
- 不新增 reducer action

**`apps/web/src/components/MessageBubble.tsx`:**
- 读取 `item.content.runStatus`
- `"retrying"` → 显示 "重试中..." + 等待动画
- `"compacting"` → 显示 "压缩上下文..." + 进度动画

**`apps/web/src/components/ConversationCanvas.tsx`:**
- 从 message 的 `runStatus` 推导状态提示（当前已从 `content.state` 推导 "Awaiting Approval"）

### 14.2 Ops dashboard — heavy deletion (Phase 2+)

删除所有 runner transport / heartbeat / daemon health 相关的 UI 和 API 类型。
18 个文件受影响（详见探索报告），核心删除：

| 文件 | 变化 |
|------|------|
| `lib/api.ts` | 删 `RunOpsListItem.runnerTransport`, `AgentRuntimeStatus.runner`, transport/heartbeat 查询参数, `DiagnosisOwner.runner` + `backend_runner_link` |
| `lib/ops-diagnosis.ts` | 删 `isDetachedRun()`, `isStaleRun()`, `isUnhealthyAgent()` runner 部分 |
| `ops/RunControlStrip.tsx` | 删 Cancel/Recover, "daemon reattached" |
| `ops/RunDiagnosisHeader.tsx` | 删 "Runner"/"Runner connection" owner 标签 |
| `ops/RunOpsTable.tsx` | 删 Transport 列, Heartbeat 列 |
| `ops/ExecutionPath.tsx` | 删 `runner_heartbeat` 阶段 |
| `ops/AgentRuntimeCard.tsx` | 删 runner 块（uptime/checkpointer/workspace），保留 surface 状态 |
| `ops/HealthSummary.tsx` | 删 stale/detached 计数 |
| `ops/NeedsAttentionList.tsx` | 删 detached/stale/Runner离线 告警 |
| `app/(main)/ops/runs/page.tsx` | 删 transport/heartbeat 筛选 |
| `app/(main)/ops/runs/[runId]/page.tsx` | 删 "Runner connection" 行, heartbeat 显示 |

### 14.3 `run-status.ts` — delete

`apps/web/src/lib/run-status.ts` 已被确认为死代码（无 import），直接删除。

### 14.4 不变的文件

- `lib/session.ts` — 纯 cookie 管理
- `components/ToolApprovalCard.tsx` — 调 `api.resumeRun()` 语义不变
- `components/StreamingCursor.tsx` — CSS 动画
- `components/Timeline.tsx` — 消息渲染
- `components/ConversationList.tsx` — 会话列表 CRUD
- `middleware.ts` — 纯 session cookie 检查

---

## 15. packages/conversation 瘦身

### 15.1 保留（领域类型）

```
packages/conversation/
  src/
    ledger.ts      — LedgerEntry, LedgerKind, parse/safeParse/serializeLedgerEntry
    member.ts      — Conversation, Member (AgentMember | HumanMember),
                     resolveTriggerTargets, assertMember, assertAgentMember
    index.ts       — 只导出上述
```

### 15.2 移除

| 内容 | 去向 |
|------|------|
| `projectForMember` | 移到 `apps/backend/src/features/conversation/projection.ts`——它属于 backend 的渲染逻辑 |
| `Message` / `MessageRevision` 等 re-export | **删除**——调用方直接 import `@chengchenccc/message` |

### 15.3 不变

- 前端 `safeParseLedgerEntry` 继续使用——SSE 事件解析
- 后端 `subscribeConversation` 继续 yield ledger entries——SSE 流
- `broadcastMessage` 仍然调 `projectForMember` 做 member 视角投影（但不写 threadProjection）

---

## 16. Risk register

| # | 风险 | 严重度 | 处理 |
|---|------|--------|------|
| 1 | `BOOTSTRAP_TEMPLATE` in `workspace.ts`） | HIGH | ✅ 决策 #22：identityPlugin 拥有 genesis，workspace.ts 不再 import |
| 2 | thread-projection 贯穿 conversation 服务 | HIGH | ✅ Phase 2 移除 `broadcastMessage` 中的调用 + 删除 adapter 接线。3 个测试文件需更新 |
| 3 | plugin-fs-memory + progressive-skill 深度耦合 AgentFsLike | HIGH | ✅ Phase 1 迁移到 cwd，14+ 文件改签名 |
| 4 | `safeRunnerAgentId` 被 lark-bot/registry.ts 引用 | MEDIUM | ✅ Phase 3 前移到公共 util 或删除 |
| 5 | 8 个测试文件依赖 runner 相关 fixture | MEDIUM | ✅ Phase 2/3 同步更新测试 |
| 6 | `scripts/dev.sh` 有 runner-daemon 注释 | LOW | ✅ 删除注释 |

---

## 17. Migration plan

### Phase 1: Add new, keep old (no breakage)

```
framework:   Agent.subscribe() + autoSummarize 改名
harness:     新增 agent-session.ts, compaction.ts, plugins/identity-plugin.ts
            index.ts 新增导出, 旧导出全部保留
tools-common: 新增 cwd 版工具工厂 (旧 API 保留)
plugins:     fs-memory + progressive-skill 改用 cwd 路径
```

**约束:** 新旧 API 共存。createGenericAgent 继续编译。每个 commit 通过 biome lint。
**与 Phase 2 的关系:** Phase 1 完成后，harness 和 tools-common 的新 API 可供 backend 使用。

### Phase 2: Backend + Frontend switch

```
backend:    main.ts → AgentSession
            features/run/* → 移除 transport 路由
            features/conversation/ → ConversationContextPlugin
              删 buildPreloadedMessages(), buildAgentSpecV2()
              删 forkRun 闭包中的 preloadedMessages 参数
            features/agent/ → 简化 workspace 为 agents/{id}
            features/runtime-ops: 删 RunnerHealthRow/computeRunnerStatus
            SSE 不新增 event type

frontend:   MessageRevision 加 runStatus 字段（packages/message）
            conversation-reducer: message action 读 runStatus
            MessageBubble: runStatus 指示器
            ops/**: 删 transport/heartbeat/daemon 相关 UI（18 个文件）
            lib/run-status.ts: 删除（死代码）
```

**约束:** 旧 runner 代码仍存在但不再被导入。backend + 前端测试通过。

### Phase 3: Delete old

```
删包:     runner-protocol, runner-daemon, agent-fs
删文件:   harness/createGenericAgent, bootstrap(旧), reflect
         tools-common/sandbox, agent-fs-like
         core/agent-fs
         backend runner-registry, runner-workspace
清理:     harness index.ts, tools-common index.ts, core index.ts
         runtime-observability types
```

### Phase 4: Architecture docs cleanup

残留 Runner 引用的文档（Phase 3 后单独 PR）：

| 文档 | 问题 | 修改 |
|------|------|------|
| `backend/data-model.md` | Runner checkpointer, projection_messages 表 | 移除 projection_messages，Checker 改为全局 db |
| `conversation/ledger.md` | buildPreloadedMessages, projection_messages | 删 buildPreloadedMessages 节，projection_messages 改为 SSE 直读 |
| `foundations/facts-and-projections.md` | buildPreloadedMessages, Runner, projection_messages | 重写事实/投影表，Agent 上下文由 ConversationContextPlugin 提供 |
| `backend/event-log.md` | Runner Daemon 参与者 | 事件来源改为 AgentSession.onEvent |
| `operations/troubleshooting.md` | Runner 本地 checkpointer, 心跳 | AgentSession 进程内执行，checkpointer.db 全局 |
| `runtime/framework.md` | Runner 协议引用 | 删除跨进程引用，Checkpointer 独立 |

**约束:** 所有旧代码引用已移除，typecheck 通过。
