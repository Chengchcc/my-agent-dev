# Phase 5: All Product Flows Use Agent Runs — Implementation Plan

## Goal

Destructively cut every Product Backend execution caller from `@my-agent-team/agent` / `createAgentSession` / `SessionManager` to the Phase 4 Agent Run services. One real Backend (`coding_agent`). No registry, no pool, no scope service, no coordinator.

## Outcome

Conversation, Cron, Loop Generator/Evaluator create durable Agent Runs through `AgentRunService` + `AgentRunExecutionService`; Loop config and Skill Pack become deterministic services; Web/Lark consume canonical Conversation History plus transient Live Updates; Ops uses Agent Run as the only Product execution identity; `apps/backend` has zero `@my-agent-team/agent` dependency and zero legacy direct execution calls.

## Prerequisites

- Phases 0–4 complete. Use the composed Phase 4 handles: `agentRunService`, `agentRunExecution`, `productTools` from `installFeatures()`.
- `AgentRunExecutionService` is the ONLY execution entry point (`dispatch` / `recover` / `retryTerminalCommit` / `stop` / `subscribe`).
- `enqueueAndAcquire()` is the only run creation path; acquired → `void dispatch(runId)`, queued → nothing.

## Non-goals

- No old session/checkpoint migration, fallback, dual write, aliases, compatibility DTOs, or legacy endpoint redirects.
- No second execution coordinator, no Pool/Registry/Scope Service recreation, no scope tables.
- Do not redesign Product Agent, Conversation, Message, Context Branch, or Agent Backend contracts.
- Do not delete repository-level packages or historical data beyond `apps/backend` (Phase 6).
- Do not start Phase 6.

## Estimated size

10 destructive steps, strict order (each caller's old path is deleted in the same step).

## Step 1 — Conversation cutover + old side-effect triage

**Files:**
- Modify: `conversation/service.ts`, `conversation-compose.ts`, `http.ts`, `ports.ts`, `adapter-sqlite.ts`, `service.test.ts`, `adapter-sqlite.test.ts`
- Delete: `lock.ts`, `lock.test.ts`, `agent-factory.ts`, `agent-projection.ts`, `run-accumulator.ts`, `run-accumulator.test.ts`, `run-accumulator.guard.test.ts`

**Actions:**
1. Replace `ConversationLock` / `activeSessions` / `startAgentRun(spanId)` / `onClear` / `onCompact` deps with `AgentRunService` + `AgentRunExecutionService` (+ `AgentContextPort` for clear-branch semantics).
2. `postMessage()`: human Message becomes canonical History first (append), then trigger rules → per-target `enqueueAndAcquire({ mode: normal|steer|follow_up, idempotencyKey })`; acquired → `void dispatch(runId)`. Return `{ seq, triggeredRuns: [{ agentMemberId, runId, queued }] }`. No spanId, no 409 busy path via lock.
   - Mode selection: branch has no active run → normal; caller wants to affect the active run → steer; otherwise follow_up. All modes persist; never call in-memory session methods.
3. `triggerMentionedAgents` → same enqueue path, best-effort.
4. `/clear`: operates the Product Context branch (existing fork/move/new-branch semantics via AgentContextPort); deletes nothing Runtime. `/compact`: unsupported/no-op (no canonical Product summary exists) — no Coding Session compact.
5. `completeRun` / `appendAssistantMessage` / `#streamingSeq` / `#forkAgentRuns` / `verifyRunOwnsConversation`: delete. Final assistant Messages come only from Phase 4 `commitCompletedRun` (already implemented).
6. Mention cascade: terminal commit explicit callback (wired in compose where `commitCompletedRun` effects live) → `findMentionedAgentMembers(message, roster)` in conversation module → enqueue per mentioned member with idempotency key `sourceRunId:targetMemberId`.
7. Title: disable auto-title; delete `title.ts` model calls (keep explicit `PATCH title` API). Goal/Memory: only if a canonical service + consumer exists in-repo; otherwise delete the path and report it (goal-state.ts is settings-backed UI state, not runtime-plugin — keep as-is if no `@my-agent-team/agent` dependency).
8. `startNewConversationForSurface`: `requestedByRunId` verification switches from span origin to `agentRunPort.getRun(runId)` + run.conversationId match.

**Check:**
```bash
bun test apps/backend/src/features/conversation
grep -RInE 'ChatModel|createModel\(|resolveModel\(|\.stream\(' apps/backend/src/features/conversation || true
```
Expected: pass; no direct model execution in conversation; no ConversationLock/activeSessions anywhere.

**Done when:** conversation Message handling only enqueues/dispatches Agent Runs; final assistant Messages appear exactly once after terminal commit; mention cascade idempotent per `sourceRunId:targetMemberId`.

## Step 2 — Cron cutover

**Files:** `cron/scheduler.ts`, `cron/scheduler.test.ts`, `cron/service.test.ts`

**Actions:**
1. Add pure id helpers (in cron module): `cronConversationId(cronJobId)`, `cronAgentMemberId(agentId)`.
2. Per fire: ensure Conversation (create if missing) + Agent Member (add if missing) via ConversationPort; `AgentContextService.getOrCreateDefaultBranch()`; then `enqueueAndAcquire({ mode: "normal", idempotencyKey: cronJobId + scheduledAt })` → acquired → `void dispatch(runId)`.
3. Timeout timer only calls `agentRunExecution.stop(runId)`. Retry creates a new Run reusing the same semantic idempotency rule; no Cron attempt state machine.
4. Remove SessionManager / ModelRegistry / ProviderAuth / session construction from scheduler; scheduler deps become `ConversationPort`-backed scope helpers + `AgentRunService` + `AgentRunExecutionService`.

**Check:**
```bash
bun test apps/backend/src/features/cron
```
Expected: restart reuses same Conversation/Member/Branch; overlap single active run; timeout → stop; retry no duplicate semantic input.

## Step 3 — Loop config de-Agented

**Files:** `loop/loop-service.ts`, `loop/http.ts`, `loop-service.test.ts`

**Actions:**
1. Delete `runLoopConfigGeneration()` Agent path and `BuildConfigFn` dependency.
2. Route creation/refinement through existing `writeDefaultLoopMd()` deterministic template generation (name/intent/project/settings → LOOP.md + fixed skill templates + cron config) as a plain service. Keep directory creation, LOOP.md write, skill template copy, cron config set.
3. Delete `update_loop_config` Product Tool and Loop config Agent/Context Branch references.

**Check:**
```bash
bun test apps/backend/src/features/loop
```
Expected: config creation/refinement tests pass with no Agent/session mocks.

## Step 4 — Loop Generator/Evaluator cutover

**Files:** `loop/loop-step.ts`, `loop-step.test.ts`, `loop-service.ts`, `http.ts`

**Actions:**
1. Id helpers: `loopGeneratorConversationId(loopId)`, `loopEvaluatorConversationId(loopId)`, `loopGeneratorMemberId(loopId)`, `loopEvaluatorMemberId(loopId)`; independent Conversations/Branches.
2. Generator: ensure scope → `enqueueAndAcquire({ mode: "normal", message: { item, LOOP.md prompt, workspace, git log, acceptance, STATE }, idempotencyKey: loopId + itemId + scheduledAt })` → acquired → dispatch. Wait for Agent Run terminal:
   - completed → continue deterministic git base/head/diff/denylist/rollback;
   - failed/aborted/timeout → existing Loop failure policy;
   - commit_failed → do not continue to Evaluator.
   - Usage from `AgentRun.terminalResult.usage`.
3. Evaluator: created only after deterministic preparation; separate scope; input = acceptance + files changed + diff/evidence + prompt + workspace; output still VERDICT.md + `parseVerdictMd` (PASS/REJECT/ESCALATE).
4. Persist `generatorRunId` / `evaluatorRunId` in loop state/evidence instead of span/session. No new Loop coordinator.
5. Remove AgentConfig / SessionManager / createAgentSession / session usage/dispose / spanId from loop-step and http.

**Check:**
```bash
bun test apps/backend/src/features/loop
```
Expected: PASS/REJECT/ESCALATE, timeout, worker crash, independent scopes; no `Agent`/`SessionManager` imports.

## Step 5 — Skill Pack deterministic service

**Files:** `skill-pack/install-session.ts`, `service.ts`, `tools.ts`, `install-session.test.ts`, `service.test.ts`

**Actions:**
1. Delete Agent/ChatModel/Plugin/progressiveSkillPlugin/createAgentSession/installer prompt usage.
2. Re-orchestrate the existing deterministic logic as plain service functions:
   - git install: pending → installing → clone/fetch → checkout versionRef → validate → copy/install → ready;
   - zip install: stage → safe unzip → validate → install → cleanup → ready;
   - sync: ready → syncing → fetch/update → validate → atomic replace → ready;
   - failure: status failed + error persisted + temp cleanup.
3. Keep zip path traversal guard, source validation, temp cleanup, state transitions, idempotency/retry. Reuse existing ports/fs adapters/helpers; do not route through `Tool.execute`.

**Check:**
```bash
bun test apps/backend/src/features/skill-pack
```
Expected: pass with zero model/Agent Run calls.

## Step 6 — Bootstrap removes Runtime composition

**Files:** `bootstrap/services.ts`, `services.test.ts`, `features.ts`, `features.test.ts`, `main.ts`, `features/agent/agent-compose.ts`, `features/agent/service.ts`, `apps/backend/package.json`

**Actions:**
1. Delete SqliteSessionManager / SessionManager / checkpointer.db / ModelRegistry / ProviderAuth-for-execution / createDefaultModelRegistry / defaultTools/defaultPlugins/defaultContextManager / supervisor→sessionManager disposal / old resume route.
2. Compose conversation/cron/loop with Phase 4 handles (`agentRunService`, `agentRunExecution`, `productTools`); conversation gets terminal-commit mention-cascade callback wired to the execution service.
3. `AgentService.hardDelete()` busy guard → query active Agent Run by agentId; remove session-id-based guards and checkpoint purge hooks.
4. Shutdown: stop accepting → drain/cancel runs → close adapters/daemon client/MCP/db (existing order, minus session manager).

**Check:**
```bash
bun test apps/backend/src/bootstrap apps/backend/src/features/agent
```
Expected: pass without checkpointer.db or in-process Agent.

## Step 7 — Agent Run API + minimal Ops

**Files:** `app.ts`, `features/runtime-ops/http.ts`, `service.ts`, `store.ts`, `insights.ts` + tests; delete `features/span/http.ts` + `http.test.ts`, `runtime-ops/checkpoint-events-store.ts` + test

**Actions:**
1. New routes (read AgentRunService + ExecutionService + adapters): `GET /api/agent-runs`, `GET /api/agent-runs/:runId`, `POST /api/agent-runs/:runId/cancel` → `agentRunExecution.stop(runId)`, `GET /api/agent-runs/:runId/events` → `subscribe(runId)`.
2. Status vocabulary: running / waiting / commit_failed / completed / failed / aborted / timeout (from agent_run rows; waiting derives from PendingAction or queued inputs).
3. Delete span/session resume, session list/detail, checkpoint terminal inference, heartbeat-as-Product-state. Keep non-Product audit rows untouched but non-authoritative.

**Check:**
```bash
bun test apps/backend/src/features/runtime-ops
```
Expected: pass using Agent Run fixtures only; no checkpoint DB opened.

## Step 8 — Web cutover

**Files:** `packages/api-contract/src/sse.ts` (+ `index.ts`), `apps/backend/src/features/conversation/http.ts` (events route shape), `apps/web/src/hooks/useConversation.ts`, `lib/conversation-reducer.ts`, `tests/lib/conversation-reducer.test.ts`, `components/ConversationCanvas.tsx`, `MessageBubble.tsx`, `Timeline.tsx`, `lib/api.ts`, `features/ops/*`, `app/(main)/system/page.tsx`, `app/(main)/system/runs/[runId]/page.tsx`, `app/(main)/work/[loopId]/runs/[runId]/page.tsx`, `components/ops/*`

**Actions:**
1. Conversation SSE stays canonical History; add transient Agent Run Live Update stream keyed by conversation/run (shared api-contract schema). Busy/waiting/failed from Agent Run status.
2. Reducer: canonicalMessages (History) + transientText/transientTools/activeRun; transient cleared when the run's final Message lands in History. No stream reconciler service.
3. Stop/cancel → `runId` endpoint; delete old approval-resume and session stop/recover client paths.
4. Ops screens → Agent Run DTOs (list/detail/cancel); spans/attempts as audit children; Loop evidence links use runId.

**Check:**
```bash
bun test packages/api-contract apps/web/tests/lib/conversation-reducer.test.ts
bun run --cwd apps/web typecheck
bun run --cwd apps/web lint
```

## Step 9 — Lark cutover

**Files:** `apps/lark-bot/src/sse-watcher.ts` + test, `render.ts` + test, `client.ts`

**Actions:**
1. Final delivery keyed by canonical Message identity from Conversation History; transient render (optional "thinking" edit) keyed by runId, never marked delivered.
2. Remove span/session-based final idempotency and streaming-Message assumptions; disconnect cannot suppress/duplicate final.

**Check:**
```bash
bun test apps/lark-bot/src/sse-watcher.test.ts apps/lark-bot/src/render.test.ts
bun run --cwd apps/lark-bot typecheck
bun run --cwd apps/lark-bot lint
```

## Step 10 — Static zero-reference + full repository gate

**Files:** fix only files owned above; delete `features/span/supervisor.ts` + `supervisor.test.ts` if Agent-execution-only, `test-helpers/mock-span.ts`, remaining legacy-only files; remove `@my-agent-team/agent` and legacy plugin/model deps from `apps/backend/package.json`.

**Check (all must exit 0 — fix the owner, never the grep):**
```bash
! grep -R '@my-agent-team/agent' apps/backend --include='*.ts' --include='package.json'
! grep -R -E 'createAgentSession|SessionManager|SqliteSessionManager|ConversationLock|activeSessions|member\.sessionId|resumeRoutes' apps/backend --include='*.ts'
! grep -R -E '\.(prompt|steer|followUp|compact)\(' apps/backend/src --include='*.ts'
! grep -R 'checkpointer\.db' apps/backend/src --include='*.ts'
! grep -R -E 'client\.api\.ops\.sessions|useOpsSession|spanId.*resume|resumeRun' apps/web apps/lark-bot --include='*.ts' --include='*.tsx'
```

Then the ordered gate:
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
Sequential execution; shared-/tmp parallel false failures avoided.

## Final phase gate

Phase 5 is complete only when all of the following are simultaneously true:

- Conversation only executes through Agent Runs.
- Cron only executes through Agent Runs.
- Loop Generator/Evaluator only execute through Agent Runs.
- Loop config generation does not depend on an Agent.
- Skill Pack install/sync does not depend on an Agent or a model.
- All final assistant Messages are written only by Phase 4 terminal commit.
- normal/steer/follow_up are all persisted before any execution.
- Busy queues keep order across restart.
- Web uses only canonical History + transient updates.
- Lark final delivery comes only from canonical History.
- Ops treats Agent Run as the only Product execution identity.
- Backend has no SessionManager/createAgentSession/ConversationLock.
- Backend has no checkpointer.db product dependency.
- `apps/backend` does not depend on `@my-agent-team/agent`.
- No compatibility layer, fallback, or dual write.
- Full repository build/typecheck/test/lint are green.
