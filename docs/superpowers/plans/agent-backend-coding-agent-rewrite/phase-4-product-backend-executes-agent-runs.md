# Phase 4: Product Backend Executes Agent Runs

**Goal:** Connect Phase 1 Agent Context/Agent Run facts to the Phase 3 Coding Agent Backend, including Product History Tools over MCP and an atomic terminal commit.

**Outcome:** A no-UI integration test creates a Conversation + Agent Member + Context Branch through existing ports, executes one Agent Run through the real `CodingAgentBackend` (HTTP/SSE → real daemon → real one-shot Worker), has the Worker call Product History Tools through the real Product Tools MCP endpoint, receives the `BackendRunOutcome`, and commits exactly one final Conversation History Message plus Context ref atomically.

**Prerequisites:** Phase 0 contracts, Phase 1 Agent Context/Agent Run services and migrations, and Phase 3 Coding Agent Service plus `@my-agent-team/adapter-coding-agent` are complete.

**Non-goals (explicitly deleted from the original plan):**
- No `AgentBackendRegistry`, `BackendModelCatalogService`, `AgentRunScopeService`, `BackendSessionCache`, `ProductToolsAuthorizationService`, `ProductToolsIdempotencyService`, `product-tools/domain-services.ts`, `AgentRunQueries`, `AgentRunPool`, or generic Backend management framework. Phase 4 has exactly one real Backend (`coding_agent`) and one real Product Tool domain (History).
- No scopeKey/headless-scope table: tests create Conversation/Member/Tree/Branch through existing ports. Stable Cron/Loop identity mapping is Phase 5 design, per real caller.
- No session cache object: `BackendSessionBinding` is the only persisted session metadata; the execution service keeps a process-lifetime `runId → { session, segment }` map for steer/stop/subscription only, removed at terminal.
- No Conversation, Cron, Loop, Skill Pack, Web, or Lark caller migration (Phase 5). No old session/checkpoint migration, `member.sessionId`, `ConversationLock`, `activeSessions`, shims, aliases, or dual writes. No fake/in-process Backend. Product Backend never imports Provider SDKs or `@my-agent-team/agent`.

**Estimated size:** 8 bounded task cards.

---

## Wave 1 — Configuration and the one real Backend

### 1.1 Add Coding Agent configuration and dependencies

**Files:** `apps/backend/src/config.ts`, `packages/config/src/env.ts`, `apps/backend/package.json`

**Actions:**
1. Add Backend-only env keys: `CODING_AGENT_URL`, `CODING_AGENT_SERVICE_TOKEN`, `PRODUCT_TOOLS_MCP_URL`, `PRODUCT_TOOLS_SERVICE_TOKEN` (optional; execution stays inert when unset).
2. Add workspace deps: `@my-agent-team/adapter-coding-agent`, `@modelcontextprotocol/sdk` (Product Tools MCP server).
3. Provider credentials remain Coding Agent daemon-only.

**Done when:** `BackendConfig` carries the four daemon/MCP settings and nothing else backend-facing.

### 1.2 Schema: run manifest + durable Product Tool calls

**Files:** `apps/backend/src/infra/db/schema.ts`, `apps/backend/drizzle/backend/0013_*.sql` (+ journal)

**Actions:**
1. `agent_run.product_tools` (JSON) - the run's Product Tool manifest, written at first dispatch; MCP validates calls against it.
2. `product_tool_call` table: `UNIQUE(run_id, call_id)`, tool name, input hash, status, result/error, timestamps - durable idempotency for semantic mutations only (read-only tools never write).

**Done when:** migration applies on `openDb` and the run row carries its manifest.

---

## Wave 2 — Product Tools: one service, History only, real MCP

### 2.1 `ProductToolsService` + durable call idempotency

**Files:** `apps/backend/src/features/product-tools/service.ts`, `adapter-sqlite.ts`, `index.ts`, `service.test.ts`

**Actions:**
1. `createProductToolsService({ runPort, contextPort, conversationPort, callPort, idGen })` exposing `call({ identity, callId, idempotencyKey, tool, args, signal })`.
2. Authorization is a private flow inside the service: load the run, verify full scope (conversation/member/branch), verify `running` status, verify the tool is declared in the run manifest - forged/terminal/undeclared calls are rejected.
3. History tools only: `history_recent`, `history_search`, `history_around`, `history_retain`. Conversation scope is always derived from the run, never from MCP arguments; `searchLedger` results are filtered to the run's conversation.
4. Read-only tools never write Context or the call ledger. `history_retain` (semantic mutation) verifies the message belongs to the conversation, is visible to the member, is not already retained, then appends a `ledger_message` ref - with durable `(runId, callId)` idempotency: exact replay returns the stored result, a different tool/input under the same id conflicts.
5. Aborted signals reject the call.

**Check:**
```bash
bun test apps/backend/src/features/product-tools/service.test.ts
```
Expected: identity/scope/manifest rejection, conversation-scoped reads, retain idempotency, conflict, and no Context writes from reads.

### 2.2 Product Tools MCP server

**Files:** `apps/backend/src/features/product-tools/mcp.ts`, `mcp.test.ts`

**Actions:**
1. `createProductToolsMcpServer({ service, serviceToken })` over the official MCP SDK (never hand-rolled JSON-RPC), serving the legacy SSE transport (`GET /sse`, `POST /messages?sessionId=`) the Coding Agent Worker's `SSEClientTransport` speaks.
2. MCP layer only: protocol parsing, Bearer service-token auth on both endpoints, input validation, error normalization to `isError` results.
3. Real MCP client test: connect with the token, list tools, call with `_meta.identity`, verify forged identity → isError, malformed input → isError, missing/wrong token → 401, retain replay-safe.

**Check:**
```bash
bun test apps/backend/src/features/product-tools/mcp.test.ts
```

### 2.3 Coding Agent MCP auth gap (Phase 3 addition)

**Files:** `apps/coding-agent/src/worker-runtime.ts`

**Actions:** the Worker's `sse:` Product Tool transport attaches `Authorization: Bearer <CODING_AGENT_PRODUCT_TOOL_TOKEN>` (service config, never in the entrypoint URI or MCP arguments).

---

## Wave 3 — Agent Run execution

### 3.1 Delivery boundary

**Files:** `apps/backend/src/features/agent-run/execution.test.ts`

**Actions:**
1. `claimNextInput` (pending → delivering) then Backend `start/resume/send` resolution is the acceptance boundary; `markInputAccepted` (delivering → delivered) happens only after resolution.
2. Acceptance-before crash: the input stays `delivering`; `recover()` redelivers with the same runId/inputId/idempotency (Backend dedupes).
3. Two inputs on one branch: queue order preserved across restart; the run consumes its inputs in order (first via start, follow-ups via send on the live segment); only the final outcome commits; after terminal, remaining follow-ups stay pending for the next run.
4. `decideExecutionPath(binding, branch, run)` is a pure function: active + same kind + live session id + synced entry + revision gap ≤ 1 → `resume`; anything else (missing/stale/kind-mismatch/sync-mismatch/commit_failed) → `rebuild` (stale binding + full projection + `start`). `configRevision`/model/systemPrompt/manifest changes never force a rebuild.

**Check:**
```bash
bun test apps/backend/src/features/agent-run/execution.test.ts
```

### 3.2 `AgentRunExecutionService`

**Files:** `apps/backend/src/features/agent-run/execution.ts`, `ports.ts`, `adapter-sqlite.ts`, `index.ts`

**Actions:**
1. `createAgentRunExecutionService({ runPort, contextPort, ledgerResolver, backend, modelCatalog, idGen, resolveWorkspace, resolveSystemPrompt?, productToolsEntrypoint })` - the Backend is the single real `CodingAgentBackend`, injected directly (no registry).
2. `dispatch(runId)`: load run → model preflight via `CodingAgentModelCatalog` → claim inputs in order → assemble `BackendStartInput`/`BackendRunInput` (history via `projectAgentContext`, manifest via `buildHistoryTools(entrypoint)`, workspace via the agent's workspace path + permission mapping) → start/resume/send → mark delivered → forward events transiently → await outcome → settle.
3. `recover()`: redeliver durable `delivering` inputs, then retry `commit_failed` runs. Called once at boot; no scheduler/lease.
4. `retryTerminalCommit(runId)`: replays the STORED outcome through the Product commit only - never re-invokes the Backend.
5. `stop(runId)`: live segment stop; otherwise finalize aborted. `subscribe(runId, signal)`: transient in-process fan-out; subscriber failure/disconnect never affects the run; events are never persisted.
6. Process-lifetime live map `runId → { session, segment }` only for steer/stop/subscription; removed at terminal.
7. Events: Backend extension events keep their namespace; terminal truth is only the outcome; malformed outcomes → failed + stale binding; `suspended` → failed (unsupported).

**Check:**
```bash
bun test apps/backend/src/features/agent-run/execution.test.ts
```

### 3.3 Terminal commit transaction

**Files:** `apps/backend/src/features/agent-run/adapter-sqlite.ts` (`commitCompletedRun`, `failCommit`)

**Actions:**
1. `commitCompletedRun({ runId, outcome, output, backendSessionId })` in ONE `backend.db` transaction: verify run is running/commit_failed + branch ownership → insert final assistant Message into `conversation_ledger` (seq) → append Context `ledger_message` ref → advance branch leaf/ledgerCursor/revision → sync `backend_session_binding` (active) → mark run `completed` with the outcome. `runId` is the commit idempotency key: replay returns the completed run, never rewrites.
2. Transaction failure → `failCommit(runId, outcome)`: run → `commit_failed` with the stored outcome, branch stays occupied, binding stale; `retryTerminalCommit` replays only the stored outcome.
3. failed/aborted/timeout → `finalizeRun` (no assistant History message) + binding stale.
4. No output Message on completed → commit the run terminal state without ledger/Context writes.

**Check:** covered by execution tests (fault: adapter test closure throwing at the end of the transaction rolls back all Product facts).

---

## Wave 4 — Composition and the real no-UI chain

### 4.1 Bootstrap wiring

**Files:** `apps/backend/src/bootstrap/features.ts`

**Actions:**
1. Assemble `sqliteAgentContextAdapter`/`sqliteAgentRunAdapter` + `createAgentRunService`, `ProductToolsService` + call adapter, `createProductToolsMcpServer` (when URL/token configured), and `CodingAgentClient/Backend/ModelCatalog` → `createAgentRunExecutionService` (when `CODING_AGENT_URL` configured; otherwise inert with a startup warning).
2. `start()` calls `agentRunExecution.recover()`; `dispose()` closes the MCP server.
3. `InstalledFeatures` exposes `agentRunService`, `agentRunExecution`, `productTools` for Phase 5 - no HTTP routes, no caller cutover.

### 4.2 Real-chain integration test

**Files:** `apps/backend/tests/integration/agent-run-coding-agent.test.ts`

**Actions:**
1. In-process real Product Tools MCP server; real Coding Agent daemon (`createCodingAgentApp` + `Bun.serve`, real worker-main) with the scripted fake provider calling `history_recent` once, then text.
2. Conversation/Member/Tree/Branch via existing ports; enqueue+acquire; `dispatch`; subscribe for live updates.
3. Assert: run `completed`; exactly one final assistant ledger message; one new Context ref; binding synced with the daemon session id; replay of the same dispatch commits nothing twice.

**Check:**
```bash
bun test apps/backend/tests/integration/agent-run-coding-agent.test.ts
```

### 4.3 Import guards

**Files:** guard test or verify-only grep

**Check:**
```bash
! grep -R '@my-agent-team/agent"' apps/backend/src/features/agent-run/execution.ts apps/backend/src/features/product-tools --include='*.ts'
! grep -R 'ConversationLock\|activeSessions\|checkpointer\|member\.sessionId' apps/backend/src/features/agent-run/execution.ts apps/backend/src/features/product-tools --include='*.ts'
! grep -R 'AgentRunExecutionService\|agentRunExecution' apps/backend/src/features/conversation apps/backend/src/features/cron apps/backend/src/features/loop apps/backend/src/features/skill-pack --include='*.ts'
```
Expected: all negated searches exit 0. Phase 4 modules have zero old-Agent runtime dependencies; no caller has cut over.

---

## Final phase gate

**Check:**
```bash
bun test apps/backend/src/features/agent-run
bun test apps/backend/src/features/product-tools
bun test apps/backend/tests/integration/agent-run-coding-agent.test.ts
bun run --cwd apps/backend typecheck
bun run --cwd apps/backend lint
```
Expected: all focused suites pass. (Note: full `apps/backend` typecheck/lint remains red on pre-existing Phase 0-3 legacy caller breakage - old `@my-agent-team/agent` API consumers in conversation/span/loop/cron/skill-pack that Phase 5 migrates; Phase 4 modules themselves compile clean.)

**Done when:**
- Product Backend dispatches a durable Agent Run to Coding Agent; inputs are marked delivered only after Backend acceptance; restart recovery redelivers in order.
- `BackendSessionBinding` decides resume/rebuild (no extra session cache).
- Product History Tools are called through the real MCP chain with identity/authorization/mutation idempotency.
- Live updates are transient only; `BackendRunOutcome` is the sole terminal authority.
- A completed outcome atomically commits History + Context + Branch + Binding + Run; `commit_failed` keeps the branch and retries from the stored outcome without re-execution.
- No UI chain exists; Conversation/Cron/Loop/Skill Pack callers are untouched; Phase 4 modules have no old-Agent imports.
- **DESTRUCTIVE CHECKPOINT - Phase 4 complete; Phase 5 may cut callers over using only enqueue/acquire, execution, Live Updates, and query.**
