# Phase 4: Product Backend Executes Agent Runs

**Goal:** Connect Phase 1 Agent Context/Agent Run facts to the Phase 3 Coding Agent Backend, including Product Tools and atomic terminal commit.

**Outcome:** A no-UI integration test creates a stable headless scope, executes one Agent Run through `CodingAgentBackend`, calls Product Tools through MCP, and commits exactly one final Conversation History Message plus Context ref.

**Prerequisites:** Phase 0 contracts, Phase 1 Agent Context/Agent Run services and migrations, and Phase 3 Coding Agent Service plus `@my-agent-team/adapter-coding-agent` are complete. Follow the dependency order in `docs/superpowers/specs/agent-backend-coding-agent-rewrite/README.md`.

**Non-goals:** Do not migrate Conversation, Cron, Loop, Skill Pack, Web, or Lark callers; that is Phase 5. Do not migrate old sessions/checkpoints, map `member.sessionId`, add compatibility shims/aliases/dual writes, or add an in-process/fake Backend. Task, Artifact, and durable approval tools remain absent until a canonical Product service exists.

**Estimated size:** 14–18 hours. Cards are 15–30 minutes and max five actions.

---

## Wave 1 — Register the real Backend and catalog

**Next concrete action:** make Product Backend able to select Coding Agent without exposing Provider internals.

### 1.1 Add Coding Agent configuration and dependencies

**Time box:** 25 minutes

**Files:**
- Modify: `apps/backend/src/config.ts`
- Modify: `apps/backend/src/config.test.ts`
- Modify: `apps/backend/package.json`
- Modify: `bun.lock`

**Actions:**
1. Add Backend-only `CODING_AGENT_URL` and `CODING_AGENT_SERVICE_TOKEN` parsing in `apps/backend/src/config.ts`; do not add them as required shared env fields used by Web/Lark.
2. Add workspace dependencies `@my-agent-team/agent-backend` and `@my-agent-team/adapter-coding-agent`.
3. Add `@modelcontextprotocol/sdk` only if the Product Tools server imports it directly.
4. Update Backend config fixtures; keep Provider credentials in Coding Agent only.

**Check:**
```bash
bun test apps/backend/src/config.test.ts
bun run --cwd apps/backend typecheck
bun install
```
Expected: config tests/typecheck pass and workspace packages resolve.

**Done when:** Product Backend has only daemon URL/service credentials and Phase 0/3 package access.

### 1.2 Implement Backend registry and model catalog

**Time box:** 30 minutes

**Files:**
- Create: `apps/backend/src/features/agent-backend/registry.ts`
- Create: `apps/backend/src/features/agent-backend/registry.test.ts`
- Create: `apps/backend/src/features/agent-backend/model-catalog.ts`
- Create: `apps/backend/src/features/agent-backend/model-catalog.test.ts`
- Create: `apps/backend/src/features/agent-backend/index.ts`

**Actions:**
1. Implement `AgentBackendRegistry.register()` and `require(kind)` with duplicate/unknown-kind errors.
2. Register only a supplied real `CodingAgentBackend`.
3. Implement `BackendModelCatalogService.list()` and `require(ref)` over Phase 3 catalog clients.
4. Return only Phase 0 `BackendModel` fields; reject duplicate `(backendKind, modelId)`.
5. Test lookup, rejection, unavailable models, and DTO shape.

**Check:**
```bash
bun test apps/backend/src/features/agent-backend
! grep -R 'Provider\|CredentialStore\|@my-agent-team/ai\|@my-agent-team/agent"' apps/backend/src/features/agent-backend --include='*.ts'
```
Expected: tests pass; grep has no matches.

**Done when:** branch `backendKind` selects one real Backend and models are listed without Provider objects.

### Wave 1 gate

**Time box:** 15 minutes

**Files:** verify only.

**Actions:** run focused tests and backend typecheck.

**Check:**
```bash
bun test apps/backend/src/features/agent-backend
bun run --cwd apps/backend typecheck
```
Expected: zero new failures.

**Done when:** Backend selection and catalog are independently usable.

---

## Wave 2 — Create stable headless Agent Run scope

**Next concrete action:** define a stable Conversation/Agent Member/Context Branch for non-UI callers without moving those callers yet.

### 2.1 Implement `AgentRunScopeService`

**Time box:** 30 minutes

**Files:**
- Create: `apps/backend/src/features/agent-run-scope/service.ts`
- Create: `apps/backend/src/features/agent-run-scope/service.test.ts`
- Create: `apps/backend/src/features/agent-run-scope/index.ts`
- Modify only if lookup is missing: `apps/backend/src/features/agent-context/{ports,adapter-sqlite}.ts`
- Modify only if canonical creation cannot be composed: `apps/backend/src/features/conversation/{ports,adapter-sqlite}.ts`

**Actions:**
1. Export `AgentRunScopeService.getOrCreateHeadless({ scopeKey, agentId, backendKind })`.
2. Idempotently create/find one Conversation, Agent Member, Agent Context Tree, and default Context Branch.
3. Persist or derive stable scope identity; never use `member.sessionId` or an in-memory lock.
4. Reject Backend mismatch; switching Backend requires a forked branch.
5. Test repeat calls, different keys, and concurrent creation.

**Check:**
```bash
bun test apps/backend/src/features/agent-run-scope/service.test.ts
```
Expected: one scope per key and isolated scopes for different keys.

**Done when:** Phase 5 callers can obtain stable scope IDs without knowing Runtime sessions.

### 2.2 Prove restart stability

**Time box:** 20 minutes

**Files:**
- Modify: `apps/backend/src/features/agent-run-scope/service.test.ts`

**Actions:**
1. Create scope in a file-backed `backend.db`.
2. Close/reopen the database and service.
3. Assert identical Conversation, Agent Member, Tree, and Branch IDs.
4. Assert no duplicate rows.

**Check:**
```bash
bun test apps/backend/src/features/agent-run-scope/service.test.ts --test-name-pattern 'restart|concurrent'
```
Expected: restart/concurrency tests pass.

**Done when:** headless scope survives Product Backend restart.

### Wave 2 gate

**Time box:** 15 minutes

**Files:** verify only.

**Actions:** run scope tests and forbidden-concept search.

**Check:**
```bash
bun test apps/backend/src/features/agent-run-scope
! grep -R 'ConversationLock\|activeSessions\|member\.sessionId\|checkpointer' apps/backend/src/features/agent-run-scope --include='*.ts'
```
Expected: tests pass; grep has no matches.

**Done when:** caller-neutral headless scope is durable.

---

## Wave 3 — Cache only live execution handles

**Next concrete action:** encode the exact native-resume predicate.

### 3.1 Implement `BackendSessionCache`

**Time box:** 30 minutes

**Files:**
- Create: `apps/backend/src/features/agent-run/session-cache.ts`
- Create: `apps/backend/src/features/agent-run/session-cache.test.ts`

**Actions:**
1. Export `resolve()`, `attach()`, `markStale()`, `detach()`, `stop()`, `close()`, and `closeAll()`.
2. Return `live`, `resume`, or `rebuild` only after matching Backend kind, branch ID, synced-through entry ID, and product revision.
3. Make any one-field mismatch stale the binding and rebuild from Agent Context.
4. Prevent reuse during `commit_failed`; remove handles even if close rejects.
5. Test process-loss, stop/close, every mismatch, stale, and detached states.

**Check:**
```bash
bun test apps/backend/src/features/agent-run/session-cache.test.ts
! grep -n 'conversation_ledger\|agent_context_entry\|@my-agent-team/agent"' apps/backend/src/features/agent-run/session-cache.ts
```
Expected: tests pass; cache contains no domain writes or old Agent import.

**Done when:** session state is discardable cache metadata, never Product truth.

---

## Wave 4 — Implement authorized Product Tools and MCP

**Next concrete action:** bind every tool call to one Agent Run identity and durable call ID.

### 4.1 Add Product Tool authorization

**Time box:** 25 minutes

**Files:**
- Create: `apps/backend/src/features/product-tools/authorization.ts`
- Create: `apps/backend/src/features/product-tools/authorization.test.ts`

**Actions:**
1. Define identity `{ runId, conversationId, agentMemberId, branchId }`.
2. Load the Agent Run and verify full scope plus active status.
3. Verify the requested tool is in the Run tool manifest.
4. Reject missing, terminal, cross-conversation/member/branch, and unknown requests.

**Check:**
```bash
bun test apps/backend/src/features/product-tools/authorization.test.ts
```
Expected: valid identity passes; every forged identity fails.

**Done when:** MCP parameters cannot escape the current Agent Run scope.

### 4.2 Add durable idempotency and audit

**Time box:** 30 minutes

**Files:**
- Create: `apps/backend/src/features/product-tools/idempotency.ts`
- Create: `apps/backend/src/features/product-tools/idempotency.test.ts`
- Modify: `apps/backend/src/infra/db/schema.ts`
- Create: `apps/backend/drizzle/backend/<next-migration>.sql`
- Create: `apps/backend/drizzle/backend/meta/<next-snapshot>.json`
- Modify: `apps/backend/drizzle/backend/meta/_journal.json`

**Actions:**
1. Add a Product Tool call table unique on `(runId, callId)` with tool/input hash, status, result/error, identity, and timestamps.
2. Return a stored terminal result for an exact replay.
3. Reject the same key with a different tool/input.
4. Persist standardized success/error audit; keep interrupted mutations explicitly recoverable.
5. Test migration, replay, conflict, and restart.

**Check:**
```bash
bun test apps/backend/src/features/product-tools/idempotency.test.ts apps/backend/src/infra/sqlite/db.test.ts
bun run --cwd apps/backend db:check:backend
```
Expected: one durable result per call ID; migration check passes.

**Done when:** MCP retries cannot repeat a Product mutation silently.

### 4.3 Implement `ProductToolsService`

**Time box:** 30 minutes

**Files:**
- Create: `apps/backend/src/features/product-tools/service.ts`
- Create: `apps/backend/src/features/product-tools/service.test.ts`
- Create: `apps/backend/src/features/product-tools/index.ts`
- Modify: `apps/backend/src/features/conversation/{ports,adapter-sqlite}.ts`
- Create: `apps/backend/src/features/product-tools/domain-services.ts`
- Create: `apps/backend/src/features/product-tools/domain-services.test.ts`
- Modify: `apps/backend/src/features/agent-context/service.ts`

**Actions:**
1. Export `ProductToolsService.call({ identity, callId, tool, input, signal })`.
2. Route authorization → idempotency → canonical domain operation → audit → optional Context retention.
3. Implement History tools: recent, search, around-seq, and retain of a visible Message ref.
4. In `domain-services.ts`, compose existing Conversation/Task/Memory/Artifact/approval services where they exist; implement missing canonical operations there behind narrow ports before exposing descriptors—do not omit a required domain or hide it in the MCP layer.
5. Write `product_tool_exchange` only for semantic exchanges; test non-semantic calls do not advance Context.

**Check:**
```bash
bun test apps/backend/src/features/product-tools/service.test.ts
```
Expected: Conversation/History/Task/Artifact/approval/Memory, replay, audit, and semantic-retention tests pass.

**Done when:** every required Product Tool domain uses Product-owned facts and no shadow domain exists.

### 4.4 Implement Product Tools MCP server

**Time box:** 30 minutes

**Files:**
- Create: `apps/backend/src/features/product-tools/mcp-server.ts`
- Create: `apps/backend/src/features/product-tools/mcp-server.test.ts`
- Modify: `apps/backend/src/features/product-tools/index.ts`

**Actions:**
1. Use `@modelcontextprotocol/sdk`; do not hand-roll JSON-RPC.
2. Export `createProductToolsMcpServer()` and list only enabled tool descriptors.
3. Require the service token plus run/member/conversation/branch identity and `callId`.
4. Propagate timeout/cancellation and standardize errors without leaking internals.
5. Test list/call, auth, forged scope, replay, malformed input, timeout, and cancellation through a real MCP client transport.

**Check:**
```bash
bun test apps/backend/src/features/product-tools/mcp-server.test.ts
```
Expected: all protocol/security/failure cases pass.

**Done when:** Coding Agent Workers synchronously call Product Tools through MCP.

### Wave 4 gate

**Time box:** 20 minutes

**Files:** verify only.

**Actions:** run all Product Tools tests, migration check, and import guard.

**Check:**
```bash
bun test apps/backend/src/features/product-tools
bun run --cwd apps/backend db:check:backend
! grep -R '@my-agent-team/agent"' apps/backend/src/features/product-tools --include='*.ts'
```
Expected: all pass; grep has no matches.

**Done when:** Product Tool identity, authorization, idempotency, audit, and MCP are closed.

---

## Wave 5 — Execute queue items only after Backend acceptance

**Next concrete action:** inject a crash between queue claim and Backend accept.

### 5.1 Test the delivery boundary

**Time box:** 30 minutes

**Files:**
- Create: `apps/backend/src/features/agent-run/execution.test.ts`

**Actions:**
1. Build a fake Phase 0 Backend whose `start/resume/send` Promise can be held or resolved; Promise resolution is the protocol acceptance boundary.
2. Crash before the Promise resolves; reopen `backend.db`; assert redelivery in original order.
3. Resolve remotely, then simulate a local crash before delivery marking; redeliver with the same delivery idempotency key and assert one semantic input.
4. Assert queue status becomes delivered only after `start/resume/send` resolves successfully.
5. Add two-item Backend/Product Backend restart ordering coverage.

**Check:**
```bash
bun test apps/backend/src/features/agent-run/execution.test.ts --test-name-pattern 'accept|redelivery|order'
```
Expected: tests define the acceptance/redelivery behavior; if written before implementation they may be red only within this card, then must be made green before `Done when`.

**Done when:** start/resume/send resolution is the acceptance boundary and idempotent redelivery tests pass.

### 5.2 Implement `AgentRunExecutionService`

**Time box:** 30 minutes

**Files:**
- Create: `apps/backend/src/features/agent-run/execution.ts`
- Modify: `apps/backend/src/features/agent-run/index.ts`
- Modify only if Phase 1 APIs are insufficient: `apps/backend/src/features/agent-run/{ports,adapter-sqlite}.ts`

**Actions:**
1. Export `dispatch(runId)`, `recover()`, `retryTerminalCommit(runId)`, `stop(runId)`, and `subscribe(runId, signal)`.
2. Load Run/Branch projection, queue item, immutable snapshot, workspace, and Product Tool descriptors.
3. Select Backend through the registry; use cache result to call live `send`, native `resume`, or Context rebuild `start`.
4. Use `runId` plus queue input ID for Backend command/input idempotency; mark delivered only after `start/resume/send` resolves successfully.
5. Recover stale delivering rows in branch creation order; reject unsupported capabilities explicitly.

**Check:**
```bash
bun test apps/backend/src/features/agent-run/execution.test.ts --test-name-pattern 'accept|redelivery|order|resume|rebuild'
```
Expected: delivery and strict resume/rebuild tests pass.

**Done when:** a durable Agent Run reaches Coding Agent without old sessions.

### 5.3 Keep Live Updates transient and map terminal errors

**Time box:** 25 minutes

**Files:**
- Modify: `apps/backend/src/features/agent-run/execution.ts`
- Modify: `apps/backend/src/features/agent-run/execution.test.ts`

**Actions:**
1. Publish core and `backend.coding_agent.*` events through `subscribe()` only; never write them to History/Context.
2. Prove subscriber disconnect/publisher failure does not change outcome processing.
3. Treat malformed events/outcomes as failed plus stale binding; never infer success from text/events.
4. Persist failed/aborted/timeout without assistant History output.
5. Reject Coding Agent `suspended` because `pendingActionResponse=false`; approval must finish inside synchronous Product Tool calls.

**Check:**
```bash
bun test apps/backend/src/features/agent-run/execution.test.ts --test-name-pattern 'transient|disconnect|malformed|failed|aborted|timeout|suspended'
```
Expected: all event/outcome cases pass.

**Done when:** `BackendRunOutcome` is the sole Agent Run terminal authority.

### Wave 5 gate

**Time box:** 20 minutes

**Files:** verify only.

**Actions:** run executor/cache suites and old-execution search.

**Check:**
```bash
bun test apps/backend/src/features/agent-run/execution.test.ts apps/backend/src/features/agent-run/session-cache.test.ts
! grep -R 'ConversationLock\|activeSessions\|checkpointer.db\|@my-agent-team/agent"' apps/backend/src/features/agent-run/{execution,session-cache}.ts
```
Expected: tests pass; grep has no matches.

**Done when:** delivery, recovery, streaming, and non-completed outcomes satisfy Phase 4.

---

## Wave 6 — Commit terminal output atomically

**Next concrete action:** fail every write in the completed transaction.

### 6.1 Add terminal commit fault injection

**Time box:** 30 minutes

**Files:**
- Modify: `apps/backend/src/features/agent-run/execution.test.ts`

**Actions:**
1. Inject failure after History insert, Context ref insert, branch update, binding update, and Run terminal update.
2. Assert each failure exposes no partial assistant History, Context ref, or revision change.
3. Assert `commit_failed` stores the serializable outcome and retains branch ownership.
4. Assert binding/cache is stale and queued follow-up remains pending.
5. Assert the next Run cannot dispatch.

**Check:**
```bash
bun test apps/backend/src/features/agent-run/execution.test.ts --test-name-pattern 'commit failure'
```
Expected: failing tests before atomic commit implementation.

**Done when:** every partial-commit risk has a deterministic invariant.

### 6.2 Implement completed commit and `commit_failed`

**Time box:** 30 minutes

**Files:**
- Modify: `apps/backend/src/features/agent-run/execution.ts`
- Modify only if transaction APIs are missing: `apps/backend/src/features/agent-run/adapter-sqlite.ts`
- Modify only if transaction APIs are missing: `apps/backend/src/features/agent-context/adapter-sqlite.ts`
- Modify only if transaction APIs are missing: `apps/backend/src/features/conversation/adapter-sqlite.ts`

**Actions:**
1. In one `backend.db` transaction insert final assistant Message with `runId`, obtain Ledger seq, append Context `ledger_message` ref, update branch leaf/revision, update binding sync, and mark Run completed.
2. Use `runId` as the unique commit idempotency key.
3. Publish canonical History/release branch only after commit.
4. On rollback, mark `commit_failed`, store outcome, and stale binding without Product fact changes.
5. Never ask the Backend to execute again during commit recovery.

**Check:**
```bash
bun test apps/backend/src/features/agent-run/execution.test.ts --test-name-pattern 'commit failure|completed commit'
```
Expected: fault injection rolls back fully; success writes all facts once.

**Done when:** terminal completion has exactly one Product commit point.

### 6.3 Replay commit idempotently and retain lock

**Time box:** 25 minutes

**Files:**
- Modify: `apps/backend/src/features/agent-run/execution.ts`
- Modify: `apps/backend/src/features/agent-run/execution.test.ts`

**Actions:**
1. Implement `retryTerminalCommit(runId)` from stored outcome only.
2. Run two concurrent retries and assert one History Message/ref/revision/completed transition.
3. Assert Backend start/send counts do not increase.
4. Keep branch locked while replay fails; release only after success.
5. After success, make only the oldest queued input eligible.

**Check:**
```bash
bun test apps/backend/src/features/agent-run/execution.test.ts --test-name-pattern 'commit_failed|concurrent retry|branch lock|queue release'
```
Expected: one commit, no re-execution, correct lock/order.

**Done when:** completed Runtime work survives Product commit failure without duplicates.

### Wave 6 gate

**Time box:** 20 minutes

**Files:** verify only.

**Actions:** run full Agent Run tests and terminal-authority search.

**Check:**
```bash
bun test apps/backend/src/features/agent-run
! grep -R 'spanId\|attemptSeq' apps/backend/src/features/agent-run/{execution,session-cache}.ts
```
Expected: suite passes; span/attempt do not drive terminal state.

**Done when:** atomic commit, `commit_failed`, replay, and lock retention pass.

---

## Wave 7 — Compose beside old callers and prove no-UI execution

**Next concrete action:** instantiate Phase 4 services without routing Product traffic to them.

### 7.1 Compose services and lifecycle

**Time box:** 30 minutes

**Files:**
- Modify: `apps/backend/src/bootstrap/services.ts`
- Modify: `apps/backend/src/bootstrap/services.test.ts`
- Modify: `apps/backend/src/bootstrap/features.ts`
- Modify: `apps/backend/src/bootstrap/features.test.ts`

**Actions:**
1. Construct Coding Agent backend/catalog clients, registry, scope service, Product Tools service/MCP server, session cache, and executor.
2. On start call `AgentRunExecutionService.recover()`; on dispose close cache, MCP, and daemon clients.
3. Expose internal `agentRunScope`, `agentRuns`, `agentRunQueries`, and `productTools` handles from `InstalledFeatures` for tests/Phase 5.
4. Keep existing SessionManager, Conversation, Cron, Loop, and Skill Pack composition unchanged.
5. Test install/dispose of both old and new graphs.

**Check:**
```bash
bun test apps/backend/src/bootstrap/services.test.ts apps/backend/src/bootstrap/features.test.ts
```
Expected: both graphs coexist; no Product caller invokes Phase 4.

**Done when:** Phase 4 is available internally and caller cutover has not begun.

### 7.2 Add no-UI real Coding Agent integration

**Time box:** 30 minutes

**Files:**
- Create: `apps/backend/tests/integration/agent-run-coding-agent.test.ts`
- Create only if needed: `apps/backend/tests/integration/helpers/coding-agent.ts`

**Actions:**
1. Launch the real Phase 3 daemon with a deterministic test model and Product Tools MCP endpoint.
2. Call `getOrCreateHeadless`, Phase 1 enqueue/acquire, then `agentRuns.dispatch(runId)` directly; do not use Web/Lark/Conversation HTTP/old Agent.
3. Make Coding Agent call Product History and return one final assistant Message.
4. Assert completed Run, one History Message, one Context ref, and matching binding revision.
5. Restart Product Backend composition; assert stable scope and valid resume-or-rebuild behavior.

**Check:**
```bash
bun test apps/backend/tests/integration/agent-run-coding-agent.test.ts
```
Expected: real HTTP/SSE + MCP Agent Run completes with one canonical commit.

**Done when:** Product Backend → Coding Agent → Product Tool → terminal commit works without UI.

### 7.3 Guard the destructive Phase boundary

**Time box:** 20 minutes

**Files:**
- Create: `apps/backend/src/features/agent-run/phase4-imports.guard.test.ts`

**Actions:**
1. Fail if new Phase 4 modules import `@my-agent-team/agent`, old Conversation execution helpers, `checkpointer.db`, or `member.sessionId`.
2. Fail if Conversation/Cron/Loop/Skill Pack imports Phase 4 services.
3. State in the failure message that all-`apps/backend` zero-old-Agent is Phase 5's gate.
4. Do not modify Product callers to make this test pass.

**Check:**
```bash
bun test apps/backend/src/features/agent-run/phase4-imports.guard.test.ts
```
Expected: new modules are clean; existing old caller imports elsewhere are allowed.

**Done when:** no compatibility coupling or premature caller migration exists.

### Wave 7 gate

**Time box:** 25 minutes

**Files:** verify only.

**Actions:** run all Phase 4 focused tests, typecheck, integration, and import search.

**Check:**
```bash
bun test apps/backend/src/features/agent-backend apps/backend/src/features/agent-run-scope apps/backend/src/features/product-tools apps/backend/src/features/agent-run
bun run --cwd apps/backend typecheck
bun test apps/backend/tests/integration/agent-run-coding-agent.test.ts
! grep -R '@my-agent-team/agent"' apps/backend/src/features/agent-backend apps/backend/src/features/agent-run/execution.ts apps/backend/src/features/agent-run/session-cache.ts apps/backend/src/features/agent-run-scope apps/backend/src/features/product-tools --include='*.ts'
```
Expected: all pass; grep has no matches.

**Done when:** every Phase 4 module is composed, tested, and isolated.

---

## Final phase gate — Prove every Phase 4 criterion

**Next concrete action:** run the exact focused evidence set; do not waive a red row.

### 8.1 Acceptance matrix

**Time box:** 30 minutes

**Files:** verify only.

**Actions:**
1. Run session exact-match/mismatch, queue accept/redelivery/order, and Backend restart tests.
2. Run terminal transaction fault injection, `commit_failed`, concurrent replay, and branch-lock tests.
3. Run Product Tool identity/authorization/idempotency/audit/MCP timeout/cancellation tests.
4. Run headless restart stability and real no-UI Coding Agent integration.
5. Run Phase 4 import and no-caller-cutover guards.

**Check:**
```bash
bun test apps/backend/src/features/agent-run/session-cache.test.ts
bun test apps/backend/src/features/agent-run/execution.test.ts
bun test apps/backend/src/features/product-tools
bun test apps/backend/src/features/agent-run-scope/service.test.ts
bun test apps/backend/tests/integration/agent-run-coding-agent.test.ts
bun test apps/backend/src/features/agent-run/phase4-imports.guard.test.ts
bun run --cwd apps/backend typecheck
```
Expected: exact match resumes; any mismatch rebuilds; accept-before-crash redelivers once; queue order survives restart; commit faults produce `commit_failed` with no partial facts and retained lock; replay writes once; forged Product Tool identity is denied; headless IDs survive restart; real no-UI execution completes; new modules have zero old-Agent imports.

**Done when:** every Phase 4 acceptance criterion has a passing focused command.

### 8.2 **DESTRUCTIVE CHECKPOINT — stop before Phase 5**

**Time box:** 15 minutes

**Files:** verify only.

**Actions:**
1. Confirm Conversation, Cron, Loop, and Skill Pack do not call Phase 4 services.
2. Confirm no old session/checkpoint migration, shim, alias, or dual write exists.
3. Confirm Agent Run terminal state comes only from `BackendRunOutcome` plus canonical commit.
4. Leave all-`apps/backend` old-Agent removal for Phase 5.

**Check:**
```bash
! grep -R 'agentRuns\|getOrCreateHeadless\|AgentRunExecutionService' apps/backend/src/features/conversation apps/backend/src/features/cron apps/backend/src/features/loop apps/backend/src/features/skill-pack --include='*.ts'
! grep -R 'checkpoint.*migrat\|compatib\|dual.write\|deprecated.*alias' apps/backend/src/features/agent-backend apps/backend/src/features/agent-run apps/backend/src/features/agent-run-scope apps/backend/src/features/product-tools --include='*.ts'
```
Expected: no matches.

**Done when:** **Phase 4 complete; Phase 5 may cut over callers using only the exported scope, enqueue/acquire, execution, Live Updates, and query/cancel services.**
