---
id: execution.agent-backend
title: Agent Backend
status: current
owners: architecture
summary: "Agent Backend 是执行 Agent Run 的引擎边界。当前唯一实现是 CodingAgentBackend：每个 Run spawn 一个一次性 coding-agent 子进程，stdin/stdout JSONL RPC，BackendRunOutcome 是唯一终态。无跨 Run session、无 resume、无 daemon。"
depends_on:
  - agents.context
used_by:
  - architecture.system-overview
  - backend.overview
  - flows.e2e-web-message
---

# Agent Backend

Agent Backend 是 Product Backend 与执行引擎之间的协议边界。Product Backend 传入 Run snapshot 与 full Product Context projection；Backend 返回 Live Updates 与唯一 `BackendRunOutcome`。

```text
Agent Run
  → Agent Backend
      → spawn one-shot coding-agent child
      → Live Updates
      → BackendRunOutcome
```

当前仓库只有一个 Agent Backend 实现：`CodingAgentBackend`（`packages/adapter-coding-agent`）。它不是一个常驻服务 —— 每个 Agent Run 独立 spawn 一个 `coding-agent --mode rpc` 子进程，子进程完成 outcome 后自行退出。

## Agent Backend 协议

```ts
interface AgentBackend<K extends string = string> {
  readonly kind: K;

  /** Start a fresh Run: full history + input + run snapshot + workspace.
   *  The segment's outcome is the run's ONLY terminal result. Same runId +
   *  same payload is idempotent (replays the accepted result); same runId +
   *  different payload conflicts. */
  execute(input: BackendRunInput<K>): Promise<BackendRunSegment<K>>;

  /** Inject a steer input into the live Run `runId`. No new Run, no new
   *  outcome. Fails explicitly when the Run is not live. */
  steer(runId: string, input: BackendInputMessage): Promise<void>;

  /** Abort the live Run `runId`. The run's outcome still resolves
   *  (aborted/failed). */
  abort(runId: string): Promise<void>;
}
```

没有 `start`/`send`/`resume`/`respond`/`close` —— 不存在跨 Run 的 session handle。`execute()` 是一次 Run 的全部输入：

```ts
interface BackendRunInput<K extends string = string> {
  history: readonly ProjectedHistoryItem[];   // full Product Context projection
  input: BackendInputMessage;                  // the run's input (normal/steer/follow_up)
  run: AgentRunSnapshot<K>;                    // runId, model, systemPrompt, skillRoots, productTools
  workspace: WorkspaceBinding;
  metadata: { conversationId, agentMemberId, branchId };
}
```

`AgentRunSnapshot` 在 Agent Run 创建时冻结（systemPrompt/skillRoots 是 Run 级快照）；queue 里的输入携带**自己的** request-time snapshot，promote 时使用输入自己的配置，绝不沿用上一个 Run 的。

## BackendRunOutcome

```ts
interface BackendRunSegment<K extends string = string> {
  events: AsyncIterable<BackendEvent<K>>;
  outcome: Promise<BackendRunOutcome>;
  stop(): Promise<void>;
}

type BackendRunOutcome =
  | { status: "completed"; output?: Message; usage?: Usage }
  | { status: "failed" | "aborted" | "timeout"; error?: string; usage?: Usage };
```

四个终态：`completed` / `failed` / `aborted` / `timeout`。**没有 `suspended`**：审批与问答通过 Product Tools MCP 同步等待（child 活着时 MCP 请求阻塞至 Product Backend 返回），Product Backend 把待响应事项持久化为 `pending_action`，但 Run 协议本身只有四个终态。`BackendRunOutcome` 是唯一终态权威，事件流永不决定终态。

## Transport：stdin/stdout JSONL

Adapter 与 child 之间是严格 JSONL 帧协议（LF 换行；stdout 只承载协议）：

```text
commands (stdin)     execute | steer | abort     （id 匹配）
outputs  (stdout)    event | outcome | response
stderr               logs only（尾部 + 脱敏由 Adapter 处理）
```

- 每个 command 有 id；child 先响应 `response { id, success }` 再继续。
- 事件是 `RunEventEnvelope { id, type, data }`，由契约包（`@my-agent-team/agent-backend`）在两侧用同一 mapping 映射为 `backend.coding_agent.*` 事件。
- 一个 Run → 一个 outcome envelope → flush → child 自行退出。Adapter 不依赖父进程关 stdin。

## Adapter 职责

- spawn 子进程（`CODING_AGENT_BIN`）并做 child 并发上限（maxConcurrentRuns）；
- JSONL 读写、command id 匹配、acceptance 排序（先记录 acceptance 再处理后续 command）；
- steer/abort 转发给 live Run；
- stderr 尾部与脱敏；
- event/outcome 映射（`mapRunEvent` / `mapRunOutcome`）；
- child recycle（outcome 后回收 spawn slot）。

## Coding Agent 如何接入

`coding-agent` 是独立 CLI（print/json/rpc 三种模式），由 Adapter 以 `--mode rpc` spawn。子进程内 `createCodingAgentRuntime()` 构造 per-Run Runtime（`packages/agent` 的 CodingAgentSession + in-memory SessionStore），seed 时把 full Product history + meta + input 原子写入，然后跑 loop。Runtime 的 model/tool loop、native tools、retry、compaction、todo、progressive skill 全部在子进程内，Run 结束即销毁。

## 不变量

1. Product Backend 只依赖 Agent Backend 接口（execute/steer/abort）。
2. `runId` 是唯一执行身份；无跨 Run session、无 resume、无 daemon。
3. 同一 Context Branch 最多一个 active Run。
4. Terminal `BackendRunOutcome` 是 Agent Run 终态唯一来源。
5. 同一 runId + 同 payload 幂等（重放接受结果）；同 runId + 不同 payload 冲突。
6. Product Backend 不读取 child 的私有 transcript；Runtime 原生工具留在 child。
7. 事件映射在契约包内两侧一致，`backend.coding_agent.*` 是扩展命名空间，产品状态机不依赖它。

## 关联页面

- [系统总览](../system-overview.md)
- [Agent Context](../agents/context.md)
- [后端总览](../backend/overview.md)
- [Coding Agent](../runtime/coding-agent.md)
- [Conversation History](../conversation/history.md)
