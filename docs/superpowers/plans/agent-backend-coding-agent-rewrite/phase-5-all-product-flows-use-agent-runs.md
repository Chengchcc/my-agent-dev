# Phase 5: All Product Flows Use Agent Runs — Implementation Plan

## Goal

Destructively cut every Product Backend execution caller from `Agent`/`createAgentSession`/`SessionManager` to the Phase 4 Agent Run scope and execution services.

## Outcome

Conversation, Cron, Loop, and Skill Pack flows create durable Agent Runs through Agent Backend; Web/Lark consume canonical Conversation History plus transient Live Updates; Ops uses Agent Run status plus audit only; `apps/backend` has zero `@my-agent-team/agent` dependency or legacy direct execution calls.

## Prerequisites

- Phases 0–4 are complete. Use `AgentRunScopeService.getOrCreateHeadless(...)`, the existing Phase 1 Agent Run enqueue/acquire API, and `AgentRunExecutionService.dispatch(runId)`, `recover()`, `retryTerminalCommit(runId)`, `stop(runId)`, and `subscribe(runId, signal)` from the Phase 4 services.
- Reuse the composed `agentRunScope`, `agentRuns`, `agentRunQueries`, and `productTools` handles; do not invent a second coordinator or wrapper. Coding Agent declares `pendingActionResponse=false`, so no replacement for the old session resume route is added.
- Run cards in order. Product caller cutover is allowed only in this phase.

## Non-goals

- No old session/checkpoint migration, fallback, dual write, aliases, compatibility DTOs, or legacy endpoint redirects.
- Do not delete legacy packages or historical data beyond what is required to make `apps/backend` use only Agent Runs; repository-wide legacy deletion belongs to Phase 6.
- Do not redesign Product Agent, Conversation, Message, Context Branch, or Agent Backend contracts.

## Estimated size

12–16 focused hours across 8 destructive waves.

## Wave 1 — Cut Conversation to durable Agent Runs

### Task 1.1 — Replace Conversation locking and direct session dispatch

**Time box:** 30 minutes

**Files:**
- Modify: `apps/backend/src/features/conversation/service.ts`
- Modify: `apps/backend/src/features/conversation/conversation-compose.ts`
- Modify: `apps/backend/src/features/conversation/service.test.ts`
- Delete: `apps/backend/src/features/conversation/lock.ts`
- Delete: `apps/backend/src/features/conversation/lock.test.ts`

**Actions:**
1. Replace `ConversationLock`, `activeSessions`, `startAgentRun(spanId, ...)`, and direct `steer`/`followUp` callbacks with the Phase 4 scope acquire/enqueue command keyed by `conversationId + agentMemberId + branchId`.
2. After the human Message is canonical, enqueue `normal`, `steer`, or `follow_up` before dispatch; branch ownership failure must enqueue without modifying Agent Context.
3. Return real `runId` values from trigger results; use Agent Run status for busy handling, not in-memory state.
4. Make `/clear` invalidate/fork Product Context as defined by Phase 1 and make `/compact` invoke Product Context summary policy; neither may call an execution session.
5. Rewrite tests for concurrent branch ownership, durable busy queues, restart ordering, and per-member scope isolation.

**Check:**
```bash
bun test apps/backend/src/features/conversation/service.test.ts
```
Expected: all Conversation command tests pass; busy input is persisted and no test constructs `ConversationLock`.

**Done when:** Conversation Message handling only creates/enqueues Agent Runs and survives reconstruction from `backend.db`.

### Task 1.2 — Remove streaming-to-History projection and session binding

**Time box:** 30 minutes

**Files:**
- Modify: `apps/backend/src/features/conversation/ports.ts`
- Modify: `apps/backend/src/features/conversation/adapter-sqlite.ts`
- Modify: `apps/backend/src/features/conversation/adapter-sqlite.test.ts`
- Delete: `apps/backend/src/features/conversation/agent-factory.ts`
- Delete: `apps/backend/src/features/conversation/agent-projection.ts`
- Delete: `apps/backend/src/features/conversation/run-accumulator.ts`
- Delete: `apps/backend/src/features/conversation/run-accumulator.test.ts`
- Delete: `apps/backend/src/features/conversation/run-accumulator.guard.test.ts`

**Actions:**
1. Remove member session binding APIs and all streaming revision mutation/dedup APIs used by the old projection.
2. Delete Agent assembly, event subscription, run accumulator, terminal callback, and in-place streaming History writes.
3. Route final assistant Message creation only through Phase 4 terminal commit; retain Conversation History notification after the transaction commits.
4. Re-home every behavior currently hidden in `agent-factory.ts`/`agent-projection.ts`: goal evaluation, memory extraction/consolidation, mention follow-on triggering, title generation, todo, recap, and pet effects. Each becomes either a canonical Product service triggered from terminal commit, a Product Tool, or an explicit Live Update consumer; none may disappear with file deletion.
5. Add integration coverage proving no final Message appears before terminal commit, exactly one appears after replay, and goal/memory/title side effects still occur exactly once.

**Check:**
```bash
bun test apps/backend/src/features/conversation
```
Expected: all tests pass; terminal commit is the sole assistant History writer and streaming updates never mutate ledger rows.

**Done when:** Conversation History contains human and terminal canonical Messages only; no Product flow reads or writes `member.sessionId`.

### Task 1.3 — Remove direct Conversation model execution

**Time box:** 25 minutes

**Files:**
- Modify or delete: `apps/backend/src/features/conversation/title.ts`
- Modify: `apps/backend/src/features/conversation/title.test.ts`
- Create: `apps/backend/src/features/conversation/run-effects.ts`
- Create: `apps/backend/src/features/conversation/run-effects.test.ts`

**Actions:**
1. Remove direct `ChatModel.stream` and model construction from Conversation feature code.
2. Move title generation to `run-effects.ts` behind an injected narrow summarizer or an explicit Agent Run; choose one and test the concrete owner.
3. Move goal evaluation and memory extraction/consolidation into `run-effects.ts` using canonical Goal/Memory ports; remove their runtime-plugin ownership.
4. Trigger title/goal/memory from terminal Message commit and make replay idempotent.
5. Add a static guard for direct model streaming/construction in Product execution features.

**Check:**
```bash
bun test apps/backend/src/features/conversation/title.test.ts apps/backend/src/features/conversation/service.test.ts
grep -RInE 'ChatModel|\.stream\(|createModel\(|resolveModel\(' apps/backend/src/features/conversation apps/backend/src/features/cron apps/backend/src/features/loop apps/backend/src/features/skill-pack || true
```
Expected: behavior tests pass; search has no direct model execution in Product flow features.

**Done when:** deleting old Agent assembly does not drop goal, memory, or title behavior and Product flows no longer call models directly.

## Wave 2 — Cut Cron to a stable headless Agent Run scope

### Task 2.1 — Replace Cron sessions, watchdog completion, and retry authority

**Time box:** 30 minutes

**Files:**
- Modify: `apps/backend/src/features/cron/scheduler.ts`
- Modify: `apps/backend/src/features/cron/scheduler.test.ts`
- Modify: `apps/backend/src/features/cron/service.test.ts`

**Actions:**
1. Resolve each Cron job to the same durable headless Conversation, Agent Member, and Context Branch on every fire/restart.
2. Create/enqueue an Agent Run with a Cron idempotency key; remove model/tool/plugin/session construction from the scheduler.
3. Drive timeout cancellation and retry decisions from Agent Run status/outcome, retaining scheduler timers only as trigger/watchdog mechanics.
4. Store retry audit against `runId`; do not infer success from span, attempt, heartbeat, or checkpoint events.
5. Test restart reuses the same branch, overlapping fires remain single-flight, timeout becomes `timeout/aborted`, and retry does not duplicate semantic input.

**Check:**
```bash
bun test apps/backend/src/features/cron
```
Expected: all Cron tests pass; scheduler dependencies contain Agent Run scope/execution services and no runtime session/model assembly.

**Done when:** every non-Loop Cron fire is a durable Agent Run on one stable headless branch.

## Wave 3 — Cut every Loop Agent caller independently

### Task 3.1 — Cut Loop configuration generation

**Time box:** 25 minutes

**Files:**
- Modify: `apps/backend/src/features/loop/loop-service.ts`
- Modify: `apps/backend/src/features/loop/http.ts`
- Add or modify: `apps/backend/src/features/loop/loop-service.test.ts`

**Actions:**
1. Replace `BuildConfigFn`/`SessionManager` inputs with Agent Run scope and execution dependencies.
2. Give Loop configuration generation a stable Product Agent member and Context Branch under the Loop Conversation.
3. Submit generation intent through an Agent Run; expose `update_loop_config` through Product Tools rather than an in-process tool closure.
4. Wait on persisted Agent Run terminal status before reading `LOOP.md` or clarification output; map failed/timeout/aborted explicitly.
5. Test create/refine reuse the generation branch and never call direct Agent APIs.

**Check:**
```bash
bun test apps/backend/src/features/loop/loop-service.test.ts
```
Expected: generation/refinement tests pass with fake Agent Run services.

**Done when:** Loop configuration creation/refinement is a Product Agent Run, not a temporary Coding Session.

### Task 3.2 — Cut Loop Generator

**Time box:** 30 minutes

**Files:**
- Modify: `apps/backend/src/features/loop/loop-step.ts`
- Modify: `apps/backend/src/features/loop/loop-step.test.ts`

**Actions:**
1. Resolve a stable Generator Product Agent + Context Branch per Loop; never share it with Evaluator.
2. Create a Generator Agent Run with workspace, role skill selection, project context, and item idempotency metadata.
3. Obtain usage and terminal state from Agent Run records/outcome; remove session subscription, `sessionId`, and disposal.
4. Keep git base/head/diff and denylist checks deterministic in Product Backend.
5. Rewrite Generator tests around run inputs/outcomes, stable scope, usage budget, and crash/timeout failure.

**Check:**
```bash
bun test apps/backend/src/features/loop/loop-step.test.ts --test-name-pattern="generator|budget|denylist"
```
Expected: focused Generator tests pass with no `Agent` or `SessionManager` mock.

**Done when:** every Generator invocation is independently identifiable by `runId` on its own stable branch.

### Task 3.3 — Cut Loop Evaluator

**Time box:** 30 minutes

**Files:**
- Modify: `apps/backend/src/features/loop/loop-step.ts`
- Modify: `apps/backend/src/features/loop/loop-step.test.ts`

**Actions:**
1. Resolve a separate stable Evaluator Product Agent + Context Branch per Loop.
2. Create the Evaluator Agent Run only after deterministic diff/denylist preparation; keep evaluator timeout in Agent Run cancellation.
3. Read the terminal result/artifact only after Agent Run terminal status; preserve empty-verdict escalation and rollback policy.
4. Persist Generator and Evaluator `runId` values in Loop state/evidence instead of span/session identifiers.
5. Test PASS/REJECT/ESCALATE, timeout, worker crash, and independent Generator/Evaluator scopes.

**Check:**
```bash
bun test apps/backend/src/features/loop
```
Expected: all Loop tests pass; no test imports `Agent`, `AgentConfig`, or `SessionManager`.

**Done when:** Generator and Evaluator use separate durable scopes and all Loop entry points share the Agent Run path.

## Wave 4 — Cut Skill Pack installer/sync to Pool-backed Agent Runs

### Task 4.1 — Replace the temporary installer Agent

**Time box:** 30 minutes

**Files:**
- Modify: `apps/backend/src/features/skill-pack/install-session.ts`
- Modify: `apps/backend/src/features/skill-pack/install-session.test.ts`
- Modify: `apps/backend/src/features/skill-pack/service.test.ts`

**Actions:**
1. Replace `ChatModel`, Plugin, Context pipeline, and `createAgentSession` dependencies with Agent Run scope/execution services.
2. Resolve a stable headless Conversation/Agent Member/Context Branch per pack and action; dispatch through the registered Agent Backend Pool.
3. Expose install/sync operations as authorized Product Tools with pack/run identity and idempotency; keep zip staging/cleanup deterministic.
4. Derive `ready`/`failed` only from tool state plus terminal Agent Run outcome; worker crash must leave the pack failed, never ready.
5. Test install, sync, retry, zip cleanup, Pool dispatch, and crash behavior.

**Check:**
```bash
bun test apps/backend/src/features/skill-pack
```
Expected: all Skill Pack tests pass and installer execution cannot bypass Agent Backend Pool.

**Done when:** Skill Pack install/sync has no temporary Agent session and satisfies the same Agent Run audit/terminal rules as other Product flows.

## Wave 5 — Converge composition and remove Backend runtime assembly

### Task 5.1 — Replace bootstrap services with Agent Backend composition

**Time box:** 30 minutes

**Files:**
- Modify: `apps/backend/src/bootstrap/services.ts`
- Modify: `apps/backend/src/bootstrap/services.test.ts`
- Modify: `apps/backend/src/bootstrap/features.ts`
- Modify: `apps/backend/src/bootstrap/features.test.ts`
- Modify: `apps/backend/src/main.ts`
- Modify: `apps/backend/src/features/agent/agent-compose.ts`
- Modify: `apps/backend/src/features/agent/service.ts`
- Delete: `apps/backend/src/features/span/agent-helpers.ts`
- Delete: `apps/backend/src/features/span/session-manager.test.ts`

**Actions:**
1. Compose the Phase 4 Agent Backend registry/pool, Context/Run/Scope services, Product Tools server, transient Live Updates, and Coding Agent Backend client.
2. Remove `SqliteSessionManager`, `checkpointer.db`, direct provider/model/tool/plugin assembly, and supervisor-to-session disposal wiring.
3. Make Agent deletion guard/query active Agent Runs and audit by Product Agent identity, not derived session ids.
4. Update feature constructors for the new dependencies; remove the old global completion listener and old resume route composition.
5. On shutdown stop accepting runs, drain/cancel Pool work per contract, then close Pool, adapter/daemon client, MCP client, Lark registry, and database in order.

**Check:**
```bash
bun test apps/backend/src/bootstrap apps/backend/src/features/agent
```
Expected: composition tests pass without creating `checkpointer.db` or an in-process Agent.

**Done when:** Product Backend bootstrap knows Agent Backend services but no Coding Session, provider SDK loop, runtime persistence, or SessionManager.

## Wave 6 — Converge Agent Run API, Ops, and audit

### Task 6.1 — Replace span/session control routes with Agent Run routes

**Time box:** 30 minutes

**Files:**
- Modify: `apps/backend/src/app.ts`
- Modify: `apps/backend/src/features/runtime-ops/http.ts`
- Modify: `apps/backend/src/features/runtime-ops/service.ts`
- Modify: `apps/backend/src/features/runtime-ops/store.ts`
- Modify: `apps/backend/src/features/runtime-ops/insights.ts`
- Modify: `apps/backend/src/features/runtime-ops/insights.test.ts`
- Modify: `apps/backend/src/features/runtime-ops/store.test.ts`
- Delete: `apps/backend/src/features/span/http.ts`
- Delete: `apps/backend/src/features/span/http.test.ts`
- Delete: `apps/backend/src/features/runtime-ops/checkpoint-events-store.ts`
- Delete: `apps/backend/src/features/runtime-ops/checkpoint-events-store.test.ts`

**Actions:**
1. Mount Agent Run status/detail/cancel endpoints keyed only by `runId`; remove old session listing/detail and span resume/recover contracts. Do not add a Coding Agent pending-action response endpoint.
2. Read terminal/busy/waiting/commit_failed state from Agent Run; use attempts/spans/events only as subordinate audit.
3. Replace checkpoint-event insights with Agent Run usage plus new audit records; never infer terminal state from the last event.
4. Ensure cancel uses the Phase 4 Agent Run stop command idempotently; synchronous Product Tool approvals remain authorized/idempotent through Product Tools.
5. Test worker crash reports failed, commit_failed remains active and keeps branch ownership, and audit disagreement cannot override Agent Run status.

**Check:**
```bash
bun test apps/backend/src/features/runtime-ops
```
Expected: Ops tests pass using Agent Run fixtures only; no checkpoint database is opened.

**Done when:** Agent Run is the only Product execution identity and terminal authority exposed by Backend APIs.

## Wave 7 — Converge Web, Lark, and shared surface contracts

### Task 7.1 — Split canonical History SSE from transient Agent Run updates

**Time box:** 30 minutes

**Files:**
- Modify: `packages/api-contract/src/sse.ts`
- Modify: `packages/api-contract/src/index.ts`
- Modify: `apps/backend/src/features/conversation/http.ts`
- Add or modify: `apps/backend/src/features/conversation/http.test.ts`
- Modify: `apps/web/src/hooks/useConversation.ts`
- Modify: `apps/web/src/lib/conversation-reducer.ts`
- Modify: `apps/web/tests/lib/conversation-reducer.test.ts`
- Modify: `apps/web/src/components/ConversationCanvas.tsx`
- Modify: `apps/web/src/components/MessageBubble.tsx`
- Modify: `apps/web/src/components/Timeline.tsx`

**Actions:**
1. Keep Conversation SSE for canonical History entries and add the Phase 4 transient Live Update stream keyed by Conversation/run with shared schemas.
2. Derive busy/waiting/failed and approval identity from Agent Run status/Live Updates, not open Message revisions, `spanId`, or Coding Agent private events.
3. Keep transient text/thinking/tool UI separate from canonical Message reducer state; reconcile/clear it when terminal History Message arrives.
4. Point stop/cancel to the new `runId` endpoint and delete the old approval resume client path for Coding Agent.
5. Test terminal Message appears once, disconnect loses only transient updates, reconnect restores canonical History plus active Agent Run status, and `backend.coding_agent.*` cannot change Product state.

**Check:**
```bash
bun test packages/api-contract apps/web/tests/lib/conversation-reducer.test.ts
bun run --cwd apps/web typecheck
```
Expected: contract/reducer tests and Web typecheck pass with no span/session execution contract.

**Done when:** Web consumes Conversation History + Live Updates and treats Agent Run status as the sole execution state.

### Task 7.2 — Make Lark resilient to transient stream loss

**Time box:** 25 minutes

**Files:**
- Modify: `apps/lark-bot/src/sse-watcher.ts`
- Modify: `apps/lark-bot/src/sse-watcher.test.ts`
- Modify: `apps/lark-bot/src/render.ts`
- Modify: `apps/lark-bot/src/render.test.ts`
- Modify: `apps/lark-bot/src/client.ts`

**Actions:**
1. Continue consuming canonical final Messages from Conversation History and optionally render transient Live Updates without persisting them as delivered History.
2. Key transient delivery by `runId`; final delivery remains keyed by canonical Message identity/idempotency.
3. Remove assumptions that streaming/waiting Message revisions or span ids define Product state.
4. Ensure Live Update disconnect/reconnect cannot suppress or duplicate the final canonical Message.
5. Test final delivery after transient disconnect, failed Agent Run display, and private Coding Agent event isolation.

**Check:**
```bash
bun test apps/lark-bot/src/sse-watcher.test.ts apps/lark-bot/src/render.test.ts
bun run --cwd apps/lark-bot typecheck
```
Expected: Lark tests/typecheck pass; canonical terminal delivery is independent of transient stream continuity.

**Done when:** Lark disconnects cannot change, lose, or duplicate the canonical Agent result.

### Task 7.3 — Cut Web Ops screens and API client to Agent Run DTOs

**Time box:** 30 minutes

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/features/ops/queries.ts`
- Modify: `apps/web/src/features/ops/hooks.ts`
- Modify: `apps/web/src/features/ops/query-keys.ts`
- Modify: `apps/web/src/app/(main)/system/page.tsx`
- Modify: `apps/web/src/app/(main)/system/runs/[runId]/page.tsx`
- Modify: `apps/web/src/app/(main)/work/[loopId]/runs/[runId]/page.tsx`
- Modify: `apps/web/src/components/ops/RunOpsTable.tsx`
- Modify: `apps/web/src/components/ops/RunDiagnosisHeader.tsx`
- Modify: `apps/web/src/components/ops/NeedsAttentionList.tsx`
- Modify: `apps/web/src/components/ops/RunInsightsPanel.tsx`

**Actions:**
1. Remove session-list/detail clients and screens; use Agent Run list/detail keyed by `runId`.
2. Display Agent Run status including waiting, commit_failed, completed, failed, aborted, and timeout; show spans/attempts only as audit children.
3. Point cancel to Agent Run commands; remove old recover/resume semantics that infer state from missing sessions.
4. Update Loop evidence links from generator span/session identifiers to Agent Run identifiers.
5. Typecheck all treaty-derived DTO usage so no old HTTP compatibility response remains.

**Check:**
```bash
bun run --cwd apps/web typecheck
bun run --cwd apps/web lint
```
Expected: Web compiles/lints using only Agent Run Product API contracts.

**Done when:** all Web execution and Ops surfaces speak Agent Run, not span/session/checkpoint terminology.

## Wave 8 — Destructive zero-reference and full compilation gate

### Task 8.1 — Remove every remaining Backend legacy execution reference

**Time box:** 25 minutes

**Files:**
- Modify: `apps/backend/package.json`
- Modify or delete as indicated by the grep results: `apps/backend/src/features/span/supervisor.ts`, `apps/backend/test-helpers/mock-span.ts`, and any remaining `apps/backend/**/*.ts` legacy-only file

**Actions:**
1. Remove `@my-agent-team/agent` and legacy runtime/plugin dependencies that no active Backend source imports.
2. Replace remaining supervisor/session mocks with Agent Run/audit fixtures, or delete tests whose subject was removed.
3. Run every static search below and fix the source, contract, or test—not the grep command.
4. Confirm no direct runtime caller was missed: Conversation, Cron, Loop config/Generator/Evaluator, Skill Pack, ops control, Web approval/stop, Lark projection, bootstrap/startup/shutdown.

**Check:**
```bash
! grep -R '@my-agent-team/agent' apps/backend --include='*.ts' --include='package.json'
! grep -R -E 'createAgentSession|SessionManager|ConversationLock|activeSessions|member\.sessionId|resumeRoutes' apps/backend --include='*.ts'
! grep -R -E '\.(prompt|steer|followUp|compact)\(' apps/backend/src --include='*.ts'
! grep -R 'checkpointer\.db' apps/backend/src --include='*.ts'
! grep -R -E 'client\.api\.ops\.sessions|useOpsSession|spanId.*resume|resumeRun' apps/web apps/lark-bot --include='*.ts' --include='*.tsx'
```
Expected: every command exits 0 because each forbidden search has zero matches.

**Done when:** `apps/backend` cannot compile against or invoke the old execution model.

### Task 8.2 — Run the Phase 5 gate and restore full repository compilation

**Time box:** 30 minutes

**Files:**
- No planned edits; fix only failures caused by this phase in the owning files above.

**Actions:**
1. Run scoped Product caller tests in order so the first ownership boundary failure is visible.
2. Run Backend typecheck and lint after all callers and bootstrap converge.
3. Run API contract, Web, and Lark checks after Backend API types are final.
4. Run the repository build and typecheck; this is the exact point where programme-wide compilation, intentionally broken by the Phase 2 destructive API removal, must return.
5. Do not proceed to Phase 6 while any command fails.

**Check:**
```bash
bun test apps/backend/src/features/conversation
bun test apps/backend/src/features/cron
bun test apps/backend/src/features/loop
bun test apps/backend/src/features/skill-pack
bun test apps/backend/src/features/agent-run apps/backend/src/features/agent-run-scope apps/backend/src/features/runtime-ops apps/backend/src/bootstrap
bun run --cwd apps/backend typecheck
bun run --cwd apps/backend lint
bun test packages/api-contract
bun run --cwd apps/web typecheck
bun run --cwd apps/web lint
bun run --cwd apps/lark-bot typecheck
bun run --cwd apps/lark-bot lint
bun run build
bun run typecheck
```
Expected: every command exits 0. In particular, `bun run build` is the full-repository compilation restoration gate for Phase 5.

**Done when:** all Phase 5 behavior and static criteria pass, every Product caller uses Agent Runs, worker crash is failed, commit_failed retains branch ownership, queues survive restart, surfaces recover from canonical facts, and full repository build/typecheck are green.

## Final phase gate

Phase 5 is complete only when all of the following are simultaneously true:

- Web Message → durable scope/acquire → Agent Backend Pool → transient Live Updates → atomic final Conversation History + Agent Context commit.
- Busy `normal`/`steer`/`follow_up` inputs survive Backend restart in order.
- Cron reuses its stable headless branch after restart.
- Loop configuration, Generator, and Evaluator each use the intended stable Product Agent scope; Generator and Evaluator are independent.
- Skill Pack installer/sync cannot bypass Pool.
- Agent Run outcome is terminal authority: Worker crash is failed; `commit_failed` does not release the Context Branch.
- Web/Lark disconnection does not affect the canonical result.
- Ops reads Agent Run plus audit and never checkpoint events for Product status.
- All static zero-reference commands and the ordered full compilation gate pass with no fallback or compatibility layer.
