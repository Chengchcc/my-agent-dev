# Phase 3：让 Coding Agent 成为独立 Agent Backend

## 目标

把 Phase 2 Runtime core 放入独立 Coding Agent Service，并通过 `CodingAgentBackend` 实现 AgentBackend 协议。

```text
Product Backend
  → CodingAgent Backend
      → HTTP commands + SSE
          → Coding Agent Service
              → CodingSessionSupervisor
                  → one Worker per active Run
```

## Worker 模型：one Run, one Worker

Coding Session 的连续性由 SQLite SessionStore 保证，不依赖长期 Worker 进程。

```text
一个 Agent Run
→ 启动一个 Worker 进程
→ Worker 打开对应 Coding Session
→ 执行一个 Run
→ 发出唯一 Outcome
→ 关闭资源并退出

下一个 Run
→ 启动新的 Worker
→ 打开同一个 Coding Session
```

- Worker 是严格 one-shot：发出 Outcome（或 compact 的 command_result）后必须自动退出，不等待下一次 Run。
- Worker 运行期间仍可接收 steer / stop_run / shutdown。
- 收到第二个正常 Run（start_run 或 normal/follow-up send）是协议违规：返回 protocol error 并退出。
- 不存在 sleeping 状态、idle reaper、wake 流程。
- Worker crash 不会恢复同一个 active Loop；Run 置为 failed，Session 置为 crashed。

## 不兼容策略

- 不支持 in-process Coding Agent fallback。
- 不支持旧 checkpointer session ID。
- 不支持 worker crash 后恢复同一 active loop。
- 不实现 respond command；pendingActionResponse=false。
- 不维护 old/new transport。
- 不保留长期 Worker 作为"以后可能性能更好"的备用路径。

## 约束

1. Daemon 是独立单租户 trust boundary。
2. Provider credential 只属于 Daemon。
3. 每 active Agent Run 一个 Worker；同一 Session 至多一个 active Run。
4. Worker 执行模型调用与 Agent Loop，执行完退出。
5. Daemon 不访问 Product DB/Ledger/Agent Context。
6. HTTP mutation 幂等；in-flight 同 key 请求合并为同一个 Promise；SSE 不是恢复真源。
7. Worker crash 使当前 Agent Run failed，不恢复 active loop。
8. Product Tool 通过 MCP 同步等待；identity 来自当前 Run snapshot。
9. compact 使用一次性 maintenance Worker，HTTP 只在 command_result 后返回。

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
3. CodingSessionSupervisor 管 start/resume/send/steer/stop/compact/close、启动限流、graceful kill、crash detection；无 sleep/wake/reap。
4. SessionRecord 状态：idle / starting / running / closing / closed / crashed；每个 Session 至多一个 active Run。
5. 每 Session 串行 mutation（Promise chain）+ in-flight idempotency dedupe；runId 全局唯一。
6. Daemon 按 run 保存有限 monotonic event buffer；SSE 支持 Last-Event-ID。
7. service credential 使用 constant-time compare。
8. CodingAgentBackend 实现 model catalog、start/send/resume/respond/stop/close、event/outcome mapping；steer 通过 `send(... mode: "steer")`，不是独立 AgentBackend method。
9. capabilities：persistentSession/nativeResume/nativeSteer=true，pendingActionResponse=false，productTools=mcp。persistentSession 表示 Coding Session 可跨 Worker 复用，不表示 Worker 长期存在。
10. 定义 Product Tools transport contract；使用 contract-test server 验证同步调用、identity、timeout、cancellation。

## 验收

- daemon 独立启动、health check、优雅关闭。
- 每个 Run 一个 Worker；Run 结束后 Worker 必定退出；同一 Session 后续 Run 使用新 PID。
- 两个 sessions 的 Worker crash 互不影响（同一 Supervisor 内）。
- Session 语义状态（branch、todo、compaction、productEntryId）跨 Worker 持久化。
- crash 后原 Run failed，不恢复 active loop。
- mutation idempotency 重放不重复启动；并发同 key 请求只 spawn 一个 Worker。
- 同一 Session 并发 normal/follow-up send 至多一个被接受。
- SSE disconnect 不改变 outcome；Last-Event-ID 可续传。
- malformed IPC 只终止对应 Worker。
- Adapter 只依赖 agent-backend contract 和 transport client。
- productEntryId 无损持久化。
- 扩展事件使用 `backend.coding_agent.*`。
- 不存在 in-process fallback、respond endpoint 或 pending continuation state。
- contract-test MCP server 可从真实 Run Worker 同步调用；tool 事件 callId 使用真实模型 tool_use ID。

## 完成条件

Coding Agent 是独立可部署的 AgentBackend。Product Backend 尚未接 Pool，也能通过 Adapter contract test 完成真实 Worker Agent Run。
