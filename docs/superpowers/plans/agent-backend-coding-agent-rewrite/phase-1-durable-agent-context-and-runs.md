# Phase 1: Durable Agent Context and Runs Implementation Plan

## Goal

Create Product Backend-owned Agent Context, Context Branch, Agent Run, durable input queue, and PendingAction facts in `backend.db`, without invoking any Agent Backend or Runtime.

## Outcome

A fresh database and a database containing existing Conversation History/Member rows both migrate destructively to the new schema. Product Backend can lazily create an Agent member's default Context Branch, project stable history, fork or move branches, atomically acquire one Agent Run per branch, recover queued inputs after restart, and consume PendingAction responses once.

## Prerequisites

- Phase 0 is complete and `@my-agent-team/agent-backend` exports `BackendModelRef`, `ProjectedHistoryItem`, `AgentRunSnapshot`, `BackendRunOutcome`, `PendingAction`, and `PendingActionResponse`.
- Read `docs/superpowers/specs/agent-backend-coding-agent-rewrite/phase-1-agent-context-and-runs.md` and treat it as authoritative.
- Preserve current `conversation`, `member`, and `conversation_ledger` product facts.

## Non-goals

- Do not call, register, resume, or mock an Agent Backend or Runtime.
- Do not migrate or read `checkpointer.db`, `checkpoint_messages`, `checkpoint_interrupts`, or `checkpoint_events`.
- Do not migrate old runtime sessions, active work, interrupts, or `member.session_id` values.
- Do not cut over Conversation, Cron, Loop, Skill Pack, or any other product caller; that occurs only in Phase 5.
- Do not add compatibility adapters, aliases, dual writes, or old/new synchronization.

## Estimated size

8 waves, 20 bounded task cards, approximately 7–10 focused engineering hours.

## Wave 1 — Make the destructive database boundary explicit

### Task 1.1 — Add migration-first database safety rules

**Time box:** 20 minutes

**Files:**
- Modify: `apps/backend/src/infra/sqlite/db.ts` — `openDb`
- Modify: `apps/backend/src/infra/sqlite/db.test.ts`

**Actions:**
1. Add `PRAGMA foreign_keys = ON` and `PRAGMA busy_timeout = 5000` in `openDb`, before Drizzle migrations run; retain WAL and `synchronous = NORMAL`.
2. Add focused assertions for `foreign_keys`, `busy_timeout`, WAL, and migration idempotency.
3. Keep `backend.db` as the only connection used by the new features.

**Check:**
```bash
bun test apps/backend/src/infra/sqlite/db.test.ts
```
Expected: all DB setup tests pass; `foreign_keys=1` and `busy_timeout=5000`.

**Done when:** Every transaction used later has foreign keys enabled and waits briefly on a competing SQLite writer.

### Task 1.2 — Define the seven Phase 1 tables and constraints

**Time box:** 30 minutes

**Files:**
- Modify: `apps/backend/src/infra/db/schema.ts`

**Actions:**
1. Remove `member.sessionId`, then add Drizzle tables `agentContextTree`, `agentContextEntry`, `agentContextBranch`, `backendSessionBinding`, `agentRun`, `branchInputQueue`, and `pendingAction` using snake-case SQL names from the Phase 1 spec.
2. Use exact product identities: `treeId`, `entryId` (the stable `productEntryId`), `branchId`, `runId`, queue `inputId`, and `actionId`; generate them later with `ulid` from `apps/backend/src/infra/ids.ts`.
3. Add foreign keys and uniqueness: tree `(conversationId, agentMemberId)`, one default branch per tree via a partial unique `is_default` index, entry parent/tree references, branch leaf/tree references, binding `branchId` primary key, run `idempotencyKey`, queue `deliveryIdempotencyKey`, and PendingAction `actionId`.
4. Add partial unique index `idx_agent_run_active_branch` on `branch_id` for statuses `running`, `waiting`, and `commit_failed`; add queue ordering index `(branch_id, created_at, input_id)`.
5. Add select schemas and JSON/boolean transforms beside the existing `createSelectSchema` declarations; store entry payload, model ref, queued Message, terminal result, PendingAction payload, and response as JSON text.

**Check:**
```bash
bun run --cwd apps/backend db:generate:backend
```
Expected: Drizzle generates one coherent change containing the seven new tables/indexes and removal of `member.session_id`; reject unrelated schema changes.

**Done when:** The database itself enforces tree scope, stable identities, queue order, and single-active-run ownership.

### Task 1.3 — Generate and inspect the destructive migration

**Time box:** 30 minutes

**Files:**
- Create: `apps/backend/drizzle/backend/0012_agent_context_and_runs.sql`
- Create: `apps/backend/drizzle/backend/meta/0012_snapshot.json`
- Modify: `apps/backend/drizzle/backend/meta/_journal.json`
- Read/inspect: `apps/backend/src/infra/db/schema.ts`

**Actions:**
1. Rename the generated SQL/snapshot tag consistently to `0012_agent_context_and_runs`; do not change schema shape after generation.
2. Ensure the SQL preserves existing `conversation`, `member`, and `conversation_ledger` rows while dropping `member.session_id` and creating the seven new tables and indexes.
3. Add no SQL that attaches, reads, copies, or checks `checkpointer.db` or any `checkpoint_*` table.
4. Mark this checkpoint in the SQL header: **DESTRUCTIVE CLEAN CUTOVER — old session/checkpoint state is intentionally discarded and cannot be restored through this migration.**

**Check:**
```bash
bun run --cwd apps/backend db:check:backend
```
Expected: Drizzle schema/migration consistency check exits 0.

**Done when:** Migration 0012 is forward-only, preserves product facts, drops the old member binding, and contains no checkpoint-data migration path.

## Wave 2 — Prove migration behavior before feature code

### Task 2.1 — Test empty and existing-product-fact migration

**Time box:** 30 minutes

**Files:**
- Modify: `apps/backend/src/infra/sqlite/db.test.ts`

**Actions:**
1. Extend the fresh-database test to assert all seven Phase 1 tables and `idx_agent_run_active_branch` exist, while `member.session_id` and all `checkpoint_*` tables do not.
2. Add a small pre-0012 fixture helper that creates the prior `conversation`, `member`, and `conversation_ledger` shapes, inserts one Agent member with a legacy session ID and one Message ledger row, then applies `0012_agent_context_and_runs.sql` by splitting Drizzle statement breakpoints.
3. Assert the Conversation, Member, and Ledger rows survive unchanged, the legacy session column is gone, and no Context/Branch is backfilled.
4. Open the migrated file again and assert migration/idempotency remains safe.

**Check:**
```bash
bun test apps/backend/src/infra/sqlite/db.test.ts
```
Expected: fresh and pre-existing fixtures both pass; no default Context is created by migration.

**Done when:** Lazy creation—not migration backfill—is proven to be the only path for existing Agent members.

### Task 2.2 — Add schema constraint smoke tests

**Time box:** 20 minutes

**Files:**
- Modify: `apps/backend/src/infra/sqlite/db.test.ts`

**Actions:**
1. Insert fixture rows and prove duplicate `(conversation_id, agent_member_id)` trees fail.
2. Prove two active runs on one branch fail while terminal historical runs coexist.
3. Prove duplicate run idempotency and queue delivery idempotency keys fail.
4. Prove deleting a Conversation cascades through its Agent Context records.

**Check:**
```bash
bun test apps/backend/src/infra/sqlite/db.test.ts --test-name-pattern 'Phase 1 constraints'
```
Expected: all uniqueness, partial-index, and cascade assertions pass.

**Done when:** The critical invariants fail closed at SQLite level rather than relying only on service code.

## Wave 3 — Build the Agent Context domain and storage port

### Task 3.1 — Define Agent Context domain types and validation

**Time box:** 25 minutes

**Files:**
- Create: `apps/backend/src/features/agent-context/domain.ts`
- Modify: `apps/backend/package.json` — add workspace dependency `@my-agent-team/agent-backend`

**Actions:**
1. Define `AgentContextTree`, `AgentContextEntry`, `ContextBranch`, `BackendSessionBinding`, and payload unions for `ledger_message`, `private_message`, `product_tool_exchange`, `summary`, and `model_change`.
2. Reuse `BackendModelRef`, `Message`, and `Usage`; do not define copies of public Agent Backend or Message types.
3. Define errors `AgentContextNotFoundError`, `ContextBranchNotFoundError`, `ContextRevisionConflictError`, and `InvalidContextEntryError`.
4. Validate that only `ledger_message` has `ledgerSeq`, Summary has `coversThroughEntryId`, and Model Change model kind matches the branch backend kind.

**Check:**
```bash
bun test apps/backend/src/features/agent-context/domain.test.ts
```
Expected: valid variants parse and invalid mixed payloads/backend model changes fail.

**Done when:** Agent Context has one precise internal representation without duplicating public domain objects.

### Task 3.2 — Define the storage contract

**Time box:** 20 minutes

**Files:**
- Create: `apps/backend/src/features/agent-context/ports.ts`

**Actions:**
1. Define `AgentContextPort` methods `getOrCreateTree`, `getTree`, `getOrCreateDefaultBranch`, `getBranch`, `listEntriesToLeaf`, `appendEntry`, `forkBranch`, `moveBranchLeaf`, `markBindingStale`, `upsertBinding`, and `getBinding`.
2. Require `expectedRevision` on branch-mutating methods and return the updated branch revision.
3. Make `getOrCreateDefaultBranch` accept explicit `backendKind`; never infer it from an old session ID.
4. Keep transaction-only run acquisition out of this port; it belongs to the Agent Run adapter because it spans queue, Ledger, Context, and Run tables.

**Check:**
```bash
bun test apps/backend/src/features/agent-context/domain.test.ts
```
Expected: TypeScript compilation through Bun succeeds with no Runtime import.

**Done when:** The port exposes product operations only and makes revision ownership explicit.

### Task 3.3 — Implement SQLite Context persistence

**Time box:** 30 minutes

**Files:**
- Create: `apps/backend/src/features/agent-context/adapter-sqlite.ts`
- Create: `apps/backend/src/features/agent-context/adapter-sqlite.test.ts`

**Actions:**
1. Implement `sqliteAgentContextAdapter(db, idGen)` with Drizzle and the existing schema/Zod parsing pattern.
2. Implement idempotent tree/default-branch creation inside `db.transaction(...).immediate()`; verify the member exists and is `kind='agent'` before creating a tree.
3. Implement append, fork, and move-leaf using `UPDATE ... WHERE branch_id=? AND revision=?`; throw `ContextRevisionConflictError` on zero changed rows.
4. Mark bindings stale on fork and every non-fast-forward leaf move; never delete entries during fork, rollback, or summary operations.
5. Store Ledger Message entries as `ledger_seq` plus type metadata only—never copy `conversation_ledger.content` into entry payload.

**Check:**
```bash
bun test apps/backend/src/features/agent-context/adapter-sqlite.test.ts
```
Expected: CRUD, CAS conflict, two-member isolation, ref-only storage, and stale-binding tests pass.

**Done when:** Context persistence is durable, branch-safe, and cannot turn shared Messages into a third content copy.

## Wave 4 — Add Context behavior and deterministic projection

### Task 4.1 — Implement lazy default Context creation and branch operations

**Time box:** 30 minutes

**Files:**
- Create: `apps/backend/src/features/agent-context/service.ts`
- Create: `apps/backend/src/features/agent-context/service.test.ts`

**Actions:**
1. Implement `createAgentContextService({ port, idGen })` with `getOrCreateDefaultBranch`, `appendPrivateMessage`, `appendProductToolExchange`, `appendSummary`, `changeModel`, `forkBranch`, and `moveBranchLeaf`.
2. Make first use of an existing Agent member create one tree and one default branch with `ledgerCursor=0`; repeated and concurrent calls return the same rows.
3. Enforce branch-fixed `backendKind`; backend changes are accepted only by `forkBranch({ backendKind: newKind })`.
4. Resolve the effective model from the last root-to-leaf `model_change`, otherwise use the supplied Product Agent default model; a current run snapshot is never mutated.

**Check:**
```bash
bun test apps/backend/src/features/agent-context/service.test.ts
```
Expected: lazy creation, two-Agent isolation, model-next-run, fork inheritance/override, and rollback-preserves-history tests pass.

**Done when:** Existing members gain Context only on first use, with no read of their deleted session binding.

### Task 4.2 — Implement root-to-leaf projection

**Time box:** 30 minutes

**Files:**
- Create: `apps/backend/src/features/agent-context/projection.ts`
- Create: `apps/backend/src/features/agent-context/projection.test.ts`

**Actions:**
1. Implement `projectAgentContext({ branchId, throughEntryId? })` returning `ProjectedHistoryItem[]` with `productEntryId` equal to the stable Context `entryId`.
2. Walk parent links root-to-leaf; reject a `throughEntryId` not on the selected branch path.
3. Apply the latest applicable Summary by replacing entries through `coversThroughEntryId`, without deleting stored entries; merge later private Messages and semantic Product Tool exchanges in order.
4. Resolve each Ledger Message ref through a narrow Conversation port query by exact `conversationId + ledgerSeq`; deserialize with `@my-agent-team/message` and fail on a missing/invalid ref rather than silently inventing content.
5. Keep projection independent of Agent Backend adapters and Runtime session state.

**Check:**
```bash
bun test apps/backend/src/features/agent-context/projection.test.ts
```
Expected: linear order, Summary replacement, stable `productEntryId`, Ledger ref resolution, and invalid-through-entry cases pass.

**Done when:** Any Agent Backend can later receive the same canonical projected history from the same branch.

### Task 4.3 — Export the feature boundary

**Time box:** 15 minutes

**Files:**
- Create: `apps/backend/src/features/agent-context/index.ts`

**Actions:**
1. Export public service/domain types and `sqliteAgentContextAdapter`.
2. Do not export row codecs, Drizzle tables, or transaction helpers.

**Check:**
```bash
bun test apps/backend/src/features/agent-context
```
Expected: all Agent Context tests pass.

**Done when:** Other Product Backend features can depend on Agent Context without depending on its SQLite details.

## Wave 5 — Remove the obsolete Conversation session binding surface

### Task 5.1 — Delete persistence APIs, not callers

**Time box:** 20 minutes

**Files:**
- Modify: `apps/backend/src/features/conversation/ports.ts` — `MemberRow`, `ConversationPort`
- Modify: `apps/backend/src/features/conversation/adapter-sqlite.ts` — returned adapter object
- Modify: `apps/backend/src/features/conversation/adapter-sqlite.test.ts`

**Actions:**
1. Remove `MemberRow.sessionId`, `ConversationPort.getMemberSessionId`, and `ConversationPort.updateMemberSessionId`.
2. Remove both SQLite adapter methods and add an assertion that member reads expose no session binding.
3. Do not edit `agent-factory.ts`, `conversation-compose.ts`, or any product caller in this Phase; their intentional compile break is resolved by Phase 5 cutover, not by a shim.
4. Do not add a fallback read from `backend_session_binding` to the Conversation port.

**Check:**
```bash
bun test apps/backend/src/features/conversation/adapter-sqlite.test.ts
grep -nE 'getMemberSessionId|updateMemberSessionId|sessionId' apps/backend/src/features/conversation/ports.ts apps/backend/src/features/conversation/adapter-sqlite.ts || true
```
Expected: adapter tests pass; `grep` prints no matches.

**Done when:** The persistence layer has exactly one new execution-session binding source and no compatibility entrance through Conversation.

## Wave 6 — Build Agent Run, durable queue, and PendingAction storage

### Task 6.1 — Define Agent Run state and commands

**Time box:** 25 minutes

**Files:**
- Create: `apps/backend/src/features/agent-run/domain.ts`
- Create: `apps/backend/src/features/agent-run/ports.ts`

**Actions:**
1. Define `AgentRun` statuses `running|waiting|commit_failed|completed|failed|aborted|timeout`, `BranchInput` modes `normal|steer|follow_up`, queue statuses `pending|delivering|delivered|cancelled`, and PendingAction statuses `pending|resolved|cancelled`.
2. Define `AcquireAgentRunCommand`, `AcquireAgentRunResult`, `ClaimedBranchInput`, and errors `BranchAlreadyActiveError`, `AgentRunConflictError`, and `PendingActionAlreadyConsumedError`.
3. Define `AgentRunPort` methods `enqueueAndAcquire`, `claimNextInput`, `markInputAccepted`, `createPendingAction`, `consumePendingAction`, `finalizeRun`, and focused getters.
4. Require stable `runId`, input `deliveryIdempotencyKey`, run `idempotencyKey`, branch `expectedRevision`, model/default snapshot inputs, and serialized terminal outcome.

**Check:**
```bash
bun test apps/backend/src/features/agent-run/domain.test.ts
```
Expected: state/command validation tests pass and `suspended` is not accepted as a terminal Agent Run status.

**Done when:** Agent Run is a product execution identity, not a Span, segment, loop, or Runtime session.

### Task 6.2 — Implement the atomic acquire command

**Time box:** 30 minutes

**Files:**
- Create: `apps/backend/src/features/agent-run/adapter-sqlite.ts`
- Create: `apps/backend/src/features/agent-run/adapter-sqlite.test.ts`

**Actions:**
1. Implement `sqliteAgentRunAdapter(db, idGen)` and execute `enqueueAndAcquire` inside one `db.transaction(...).immediate()` transaction.
2. Always insert the input idempotently first; if the branch has an active run or its revision CAS fails, return `{ acquired:false, queued:true }` without appending Context entries or moving `ledgerCursor`.
3. On success: CAS the branch revision; scan Ledger after `ledgerCursor`; include only non-undone `message` rows whose parsed Message is not `visibility='internal'` and is broadcast, addressed to the Agent member, or sent by that member; select the latest 20 eligible Messages in ledger order; append only Ledger refs; advance the cursor through the highest scanned sequence; resolve the effective model; create the active Agent Run; mark the selected queue item `delivering` with the same stable delivery key.
4. Use the active-run partial unique index as the final race guard and map its constraint failure to the queued result.
5. Never call an Agent Backend and never write streaming/process/checkpoint data.

**Check:**
```bash
bun test apps/backend/src/features/agent-run/adapter-sqlite.test.ts --test-name-pattern 'acquire'
```
Expected: one concurrent acquire succeeds; the loser is queued and leaves branch leaf/cursor/revision unchanged.

**Done when:** Ownership, visible History sync, cursor movement, Run creation, and queue claim are one atomic Product Backend command.

### Task 6.3 — Implement recoverable queue delivery

**Time box:** 25 minutes

**Files:**
- Modify: `apps/backend/src/features/agent-run/adapter-sqlite.ts`
- Modify: `apps/backend/src/features/agent-run/adapter-sqlite.test.ts`

**Actions:**
1. Implement `claimNextInput` to return an existing oldest `delivering` row before claiming the oldest `pending` row, preserving `(createdAt,inputId)` order and the same delivery idempotency key across restart.
2. Implement `markInputAccepted` as CAS from `delivering` to `delivered`; duplicate acceptance returns the already-delivered row.
3. Never mark an input delivered merely because it was read or claimed.
4. Cover normal, steer, and follow-up with the same durable ordering rules.

**Check:**
```bash
bun test apps/backend/src/features/agent-run/adapter-sqlite.test.ts --test-name-pattern 'queue|restart|accept'
```
Expected: restart order is stable, pre-accept crash reclaims the same delivery, and acceptance is idempotent.

**Done when:** No accepted input is lost and no unaccepted input is falsely acknowledged.

### Task 6.4 — Implement consume-once PendingAction and terminal CAS

**Time box:** 25 minutes

**Files:**
- Modify: `apps/backend/src/features/agent-run/adapter-sqlite.ts`
- Modify: `apps/backend/src/features/agent-run/adapter-sqlite.test.ts`

**Actions:**
1. Implement `createPendingAction` to set the Run to `waiting` without releasing the active branch slot.
2. Implement `consumePendingAction` with `UPDATE ... WHERE status='pending'`; the same response idempotency key returns the stored result, while a conflicting second response throws `PendingActionAlreadyConsumedError`.
3. Implement `finalizeRun` with run-ID CAS: identical terminal replay returns the stored Run; a conflicting terminal outcome fails; terminal statuses release the partial-index active slot.
4. Keep `commit_failed` active and keep its terminal result for Phase 4 replay.

**Check:**
```bash
bun test apps/backend/src/features/agent-run/adapter-sqlite.test.ts --test-name-pattern 'PendingAction|terminal|commit_failed'
```
Expected: consume-once, identical replay, conflicting replay, and active-slot behavior pass.

**Done when:** PendingAction and terminal outcome persistence remain correct across retries and process restarts.

## Wave 7 — Add the Agent Run service without Runtime integration

### Task 7.1 — Implement the product-facing service

**Time box:** 25 minutes

**Files:**
- Create: `apps/backend/src/features/agent-run/service.ts`
- Create: `apps/backend/src/features/agent-run/service.test.ts`
- Create: `apps/backend/src/features/agent-run/index.ts`

**Actions:**
1. Implement `createAgentRunService({ port, contextService, idGen })` as validation/orchestration over the transactional port.
2. For an existing Agent member with no Context, lazily get/create its default branch, then call `enqueueAndAcquire`; never consult `member.session_id`.
3. Expose queue/PendingAction/finalization operations but no execute/start/send/resume/respond method.
4. Export only domain types, service factory, and SQLite adapter.

**Check:**
```bash
bun test apps/backend/src/features/agent-run/service.test.ts
```
Expected: lazy existing-member acquisition, queued failure, model-next-run, and no-Runtime behavior pass.

**Done when:** Product code can create and manage durable Runs while execution remains intentionally absent.

### Task 7.2 — Add cross-feature focused scenarios

**Time box:** 30 minutes

**Files:**
- Modify: `apps/backend/src/features/agent-run/service.test.ts`

**Actions:**
1. Fixture one Conversation with two Agent members and prove their Trees, Branches, cursors, projected histories, and active Runs are isolated.
2. Prove a model change affects only the next Run snapshot.
3. Prove fork and move-leaf preserve all entries, mark binding stale, and projection follows the selected leaf.
4. Close/reopen a file-backed `backend.db` and prove queue order, delivering recovery, PendingAction state, and terminal replay survive restart.
5. Assert stored Context Ledger entries contain `ledgerSeq` and stable `entryId` but no copied Message content.

**Check:**
```bash
bun test apps/backend/src/features/agent-run/service.test.ts
```
Expected: all cross-feature durability and isolation scenarios pass.

**Done when:** Every Phase 1 behavioral gate is demonstrated against real SQLite, not mocks.

## Wave 8 — Final destructive phase gate

### Task 8.1 — Run the focused Phase 1 gate

**Time box:** 20 minutes

**Files:**
- Verify only; no new files.

**Actions:**
1. Run database, Agent Context, Agent Run, and Conversation adapter tests.
2. Run Drizzle's schema check.
3. Search the new feature/migration surface for forbidden checkpoint dependencies.
4. Confirm no product caller was cut over and no Runtime execution module was added.

**Check:**
```bash
bun test apps/backend/src/infra/sqlite/db.test.ts \
  apps/backend/src/features/agent-context \
  apps/backend/src/features/agent-run \
  apps/backend/src/features/conversation/adapter-sqlite.test.ts
bun run --cwd apps/backend db:check:backend
grep -RInE 'checkpoint_(messages|interrupts|events)|checkpointer\.db|@my-agent-team/agent' \
  apps/backend/src/features/agent-context \
  apps/backend/src/features/agent-run \
  apps/backend/drizzle/backend/0012_agent_context_and_runs.sql
```
Expected: focused tests pass; Drizzle check exits 0; forbidden-dependency search prints no matches. A full backend typecheck is not this Phase's gate because deletion of the old Conversation session-binding port intentionally leaves old product callers broken until Phase 5; do not repair that with compatibility code.

**Done when:** All Phase 1 acceptance points pass, and the only persisted execution model available to new code is Agent Context + Agent Run in `backend.db`.

### Task 8.2 — Record the phase gate explicitly

**Time box:** 15 minutes

**Files:**
- Review: `docs/superpowers/specs/agent-backend-coding-agent-rewrite/phase-1-agent-context-and-runs.md`

**Actions:**
1. Check each acceptance item against a named test: existing fixture migration, no checkpointer dependency, concurrent acquire, member isolation, ref-only entries, next-run model, non-destructive branch operations, stable product entry identity, lazy default branch, restart queue order, pre-accept reclaim, consume-once action, and run-ID terminal idempotency.
2. Reject the Phase if any behavior is covered only by a comment or service-level assumption where a database constraint/CAS is required.
3. Confirm the destructive policy remains explicit: no checkpoint migration, no old session restoration, no compatibility read, no dual write, and no caller cutover before Phase 5.

**Check:**
```bash
grep -nE 'checkpoint|member\.session|dual write|compatib|Phase 5|Runtime' \
  docs/superpowers/plans/agent-backend-coding-agent-rewrite/phase-1-durable-agent-context-and-runs.md
```
Expected: matches occur only in explicit prohibitions, destructive policy, and phase-boundary statements.

**Done when:** Phase 1 leaves a complete, durable, Runtime-disconnected Product Backend control plane and no hidden route back to old execution state.
