# Phase 3：让 Coding Agent 成为独立 Agent Backend

## 目标

把 Phase 2 Runtime core 放入独立 Coding Agent Service，并通过 `CodingAgentBackend` 实现 AgentBackend 协议。

```text
Product Backend
  → CodingAgent Backend
      → HTTP commands + SSE
          → Coding Agent Service
              → CodingSessionSupervisor
                  → one Worker per live Coding Session
```

## 不兼容策略

- 不支持 in-process Coding Agent fallback。
- 不支持旧 checkpointer session ID。
- 不支持 worker crash 后恢复同一 active loop。
- 不实现 respond command；pendingActionResponse=false。
- 不维护 old/new transport。

## 约束

1. Daemon 是独立单租户 trust boundary。
2. Provider credential 只属于 Daemon。
3. 每 live Coding Session 一个 Worker。
4. Worker 执行模型调用与 Agent Loop。
5. Daemon 不访问 Product DB/Ledger/Agent Context。
6. HTTP mutation 幂等；SSE 不是恢复真源。
7. Worker crash 使当前 Agent Run failed。
8. Product Tool 通过 MCP 同步等待。

## 目标文件

```text
apps/coding-agent/
  package.json
  tsconfig.json
  src/config.ts
  src/main.ts
  src/app.ts
  src/server.ts
  src/routes.ts
  src/session-supervisor.ts
  src/session-record.ts
  src/worker-protocol.ts
  src/worker-main.ts
  src/event-buffer.ts

packages/adapter-coding-agent/
  package.json
  tsconfig.json
  src/client.ts
  src/backend.ts
  src/event-mapper.ts
  src/transport.ts
  src/index.ts
```

## 实现步骤

1. 定义 transport DTO：session create/open/close、loop start/steer/stop、compact、events、outcome。
2. Worker IPC 使用 NDJSON stdin/stdout；每条消息带 session/run/command/event identity。
3. CodingSessionSupervisor 管 start/open/sleep/wake/stop/close、启动限流、idle reap、graceful kill、crash detection。
4. Daemon 按 run 保存有限 monotonic event buffer；SSE 支持 Last-Event-ID。
5. service credential 使用 constant-time compare。
6. CodingAgentBackend 实现 model catalog、start/send/resume/respond/stop/close、event/outcome mapping；steer 通过 `send(... mode: "steer")`，不是独立 AgentBackend method。
7. capabilities：persistentSession/nativeResume/nativeSteer=true，pendingActionResponse=false，productTools=mcp。
8. 定义 Product Tools transport contract；使用 contract-test server 验证同步调用、identity、timeout、cancellation。

## 验收

- daemon 独立启动、health check、优雅关闭。
- 两个 sessions 在不同 Worker PID 中运行。
- 一个 Worker crash 不影响另一个。
- idle sleep 后恢复已完成 session state。
- crash 后原 Run failed，不恢复 active loop。
- mutation idempotency 重放不重复启动。
- SSE disconnect 不改变 outcome；Last-Event-ID 可续传。
- malformed IPC 只终止对应 Worker。
- Adapter 只依赖 agent-backend contract 和 transport client。
- productEntryId 无损持久化。
- 扩展事件使用 `backend.coding_agent.*`。
- 不存在 in-process fallback、respond endpoint 或 pending continuation state。
- contract-test MCP server 可从 Worker 同步调用。

## 完成条件

Coding Agent 是独立可部署的 AgentBackend。Product Backend 尚未接 Pool，也能通过 Adapter contract test 完成真实 Worker Agent Run。
