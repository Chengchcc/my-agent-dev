# Phase 2: Complete Oma Implementation Plan

## Goal

Replace the current `@chengchenccc/agent` facade with a Worker-local Oma runtime that has one Agent Loop owner, one durable Coding Session Tree, static plugins, sandboxed tools, progressive skills, and a provider-backed `ModelRuntime`.

## Outcome

A single-process harness can create/open a Coding Session and complete an Agent Loop with model streaming, batched tools, retry/compaction/steer/follow-up behavior, durable todo state, and awaited lifecycle listeners. In-memory and SQLite stores obey the same contract. The old `Agent`, `AgentSDK`, `createAgentSession`, `SessionManager`, flat stores, durable resume, hook adapter, and compatibility exports are gone. Product callers remain intentionally unmigrated until Phase 5.

## Prerequisites

- Phase 0 contracts exist in `packages/agent-backend`; use `ProjectedHistoryItem` and `AgentRunSnapshot` rather than inventing Product Backend types.
- Read `docs/superpowers/specs/agent-backend-oma-rewrite/phase-2-oma-core.md` and the four `docs/architecture/runtime/oma*.md` documents before implementation.
- Work on the programme branch; temporary downstream TypeScript failures are allowed and must not be “fixed” with aliases, adapters, dual writes, or caller migration.

## Non-goals

- Do not migrate `apps/backend`, Cron, Loop, Conversation, Skill Pack, or any Product caller; that happens only in Phase 5.
- Do not implement the Phase 3 daemon, HTTP/SSE transport, worker supervisor, sleep/wake, or process crash orchestration.
- Do not recover an active/waiting Agent Loop after crash, read old checkpoints, migrate old session data, dynamically reload plugins, or persist Product Memory/Agent Context.
- Do not preserve old exports, event aliases, facade shapes, flat stores, `ModelChangeEntry`, or compatibility plugin adapters.

## Estimated size

16 task cards, approximately 7–9 focused engineering hours. Each card is independently runnable at its package boundary; the whole workspace may remain broken until Phase 5.

## Wave 1 — Cut the model boundary first

### Task 1: Introduce ModelRuntime without deleting legacy exports

**Time box:** 30 minutes

**Files:**
- Modify: `packages/ai/src/types.ts`
- Create: `packages/ai/src/model-runtime.ts`
- Create: `packages/ai/src/model-runtime.test.ts`
- Modify: `packages/ai/src/index.ts`

**Actions:**
1. Define `Provider`, `CredentialStore`, normalized provider errors, catalog refresh results, availability, and the new `ModelRuntime` API.
2. Implement provider registration/replacement, model lookup, credential resolution, availability filtering, refresh/cache, and stream dispatch.
3. Keep old registry/resolver exports temporarily inside `packages/ai` until Task 2 converts every provider/config caller; do not use them in new Oma code.
4. Add tests for duplicate/replaced providers, missing credentials, availability filtering, refresh, dispatch, and normalized errors.

**Check:**

```bash
bun test packages/ai/src/model-runtime.test.ts
```

Expected: new `ModelRuntime` tests pass while existing providers still compile against the old contract.

**Done when:** the new model boundary exists without breaking provider/config files before their conversion card.

### Task 2: Convert all providers/config and remove old AI contracts

**Time box:** 30 minutes

**Files:**
- Rewrite: `packages/ai/src/providers/anthropic.ts`
- Rewrite: `packages/ai/src/providers/openai-compat.ts`
- Modify: `packages/ai/src/providers/custom.ts`
- Modify: `packages/ai/src/providers/deepseek.ts`
- Modify: `packages/ai/src/provider-config.ts`
- Modify: `packages/ai/src/builtin-providers.ts`
- Delete: `packages/ai/src/registry.ts`
- Delete: `packages/ai/src/resolve-model.ts`
- Modify: `packages/ai/src/index.ts`
- Create: `packages/ai/src/providers/provider-contract.test.ts`

**Actions:**
1. Make providers own auth metadata, model catalog, API conversion, `stream()`, and provider-error normalization without caching credential-bearing `ChatModel` objects.
2. Resolve credentials per request through `ModelRuntime`; redact credential/header material from thrown errors.
3. Cover Anthropic and OpenAI-compatible streaming with deterministic fake fetch responses, including transient, overflow, auth, invalid-request, aborted, and fatal classifications.
4. Update every `packages/ai` provider/config caller, then remove `ModelRegistry`, `createModelRegistry`, old `resolveModel`, and `Provider.createModel` exports in the same card.

**Check:**

```bash
bun test packages/ai/src/providers/provider-contract.test.ts
bunx tsc -p packages/ai/tsconfig.test.json --noEmit
```

Expected: both provider contract suites pass and `packages/ai` typechecks.

**Done when:** Anthropic and OpenAI-compatible providers satisfy the same stream/error contract, and credential values never appear in models, errors, or test event payloads.

## Wave 2 — Replace persistence with one SessionStore

### Task 3: Define the Coding Session Tree and shared store contract

**Time box:** 25 minutes

**Files:**
- Rewrite: `packages/agent/src/persistence/session-tree.ts`
- Create: `packages/agent/src/persistence/session-store.ts`
- Create: `packages/agent/src/persistence/session-store.contract.ts`
- Delete: `packages/agent/src/persistence/session-storage.ts`
- Delete: `packages/agent/src/persistence/session-repo.ts`
- Delete: `packages/agent/src/persistence/session.ts`

**Actions:**
1. Define `MessageEntry`, `CompactionEntry`, `TodoStateEntry`, `CodingSessionMetadata`, `CodingSessionSnapshot`, and the sole `leaf_moved` operation; remove `ModelChangeEntry`.
2. Define `SessionStore.create/open/delete/appendBatch/moveLeaf/readBranch/findByProductEntryIds` with one serialized writer per session.
3. Make `appendBatch` accept a linear batch, derive parents from the current leaf, skip duplicate `productEntryId` values, and update the leaf only after the whole batch succeeds.
4. Export a reusable contract suite covering CRUD, branch reads, atomic batches, idempotency, leaf movement, todo recovery, compaction retention, and cache reconstruction.

**Check:**

```bash
bun test packages/agent/src/persistence/session-store.contract.ts
```

Expected: the contract module loads with no standalone tests; adapters will invoke it in Tasks 4–5.

**Done when:** there is one store port and one entry union; no repository/storage/session wrapper or model-change entry remains.

### Task 4: Implement the in-memory SessionStore

**Time box:** 20 minutes

**Files:**
- Create: `packages/agent/src/persistence/in-memory-session-store.ts`
- Create: `packages/agent/src/persistence/in-memory-session-store.test.ts`
- Delete: `packages/agent/src/persistence/memory-session-storage.ts`

**Actions:**
1. Implement the contract with per-session entries, operations, metadata leaf cache, product-entry index, and a per-session mutation queue.
2. Ensure failed validation writes nothing and concurrent appends cannot create accidental siblings from one old leaf.
3. Run the shared contract suite against the in-memory factory.

**Check:**

```bash
bun test packages/agent/src/persistence/in-memory-session-store.test.ts
```

Expected: the complete shared SessionStore suite passes.

**Done when:** the in-memory adapter proves atomic input batches, idempotent Product history, recoverable leaf state, and restart-style todo reconstruction.

### Task 5: Implement one-SQLite-file-per-session storage

**Time box:** 30 minutes

**Files:**
- Rewrite: `packages/agent/src/persistence/sqlite-session-storage.ts` as `packages/agent/src/persistence/sqlite-session-store.ts`
- Create: `packages/agent/src/persistence/sqlite-session-store.test.ts`
- Delete: `packages/agent/src/persistence/sqlite-session-repo.ts`
- Delete: `packages/agent/src/persistence/sqlite-persistence.ts`
- Delete: `packages/agent/src/persistence/schema.ts`
- Delete: `packages/agent/drizzle/0000_breezy_winter_soldier.sql`
- Delete: `packages/agent/drizzle/meta/_journal.json`
- Delete: `packages/agent/drizzle/meta/0000_snapshot.json`

**Actions:**
1. Create a compact `bun:sqlite` schema for metadata, entries, operations, and unique non-null `product_entry_id`; do not inspect or migrate checkpoint tables.
2. Commit entries, the final `leaf_moved` operation, and metadata leaf cache in one SQLite transaction.
3. On open, rebuild and repair the leaf cache from the operation log when the cache is absent or stale.
4. Run the same contract suite against temporary per-session database files, including rollback after a deliberately failed batch.

**Check:**

```bash
bun test packages/agent/src/persistence/sqlite-session-store.test.ts
```

Expected: the shared suite passes for SQLite, including transaction rollback and leaf-cache reconstruction.

**Done when:** SQLite behavior matches memory behavior exactly and no legacy checkpoint table or migration path exists.

## Wave 3 — Make prompt and context construction side-effect free

### Task 6: Add atomic loop input and prompt rendering

**Time box:** 25 minutes

**Files:**
- Create: `packages/agent/src/runtime/loop-input.ts`
- Create: `packages/agent/src/runtime/loop-input.test.ts`
- Create: `packages/agent/src/runtime/prompt.ts`
- Create: `packages/agent/src/runtime/prompt.test.ts`

**Actions:**
1. Convert `ProjectedHistoryItem[]` into `source: "product_history"` entries and append history + exactly one `source: "meta"` user message + exactly one `source: "prompt"` user message in one batch.
2. Keep rendered System Prompt only in the loop snapshot; record only its hash in loop metadata.
3. Render `<system-reminder>` with non-empty Markdown sections from static plugin meta providers, runtime/workspace facts, skill index, Product context supplied in the snapshot, model, and todo reminder.
4. Test history idempotency, Meta-before-Prompt order, retry reuse, follow-up creating a new batch, steer adding only `source: "steer"`, and absence of System Prompt from the tree.

**Check:**

```bash
bun test packages/agent/src/runtime/loop-input.test.ts packages/agent/src/runtime/prompt.test.ts
```

Expected: tests show one Meta per loop, no duplicate input on retry, no Meta on steer, and no System Prompt entry.

**Done when:** every new Agent Loop has one immutable input snapshot and the tree preserves Meta and Prompt as separate consecutive user messages.

### Task 7: Replace implicit summarization with explicit context shaping and compaction

**Time box:** 30 minutes

**Files:**
- Rewrite: `packages/agent/src/context/context-manager.ts` as `packages/agent/src/context/context-pipeline.ts`
- Modify: `packages/agent/src/context/token-budget.ts`
- Modify: `packages/agent/src/context/tool-result-truncator.ts`
- Modify: `packages/agent/src/context/compaction/cut-point.ts`
- Modify: `packages/agent/src/context/compaction/prompts.ts`
- Modify: `packages/agent/src/context/compaction/shake.ts`
- Create: `packages/agent/src/context/context-pipeline.test.ts`
- Create: `packages/agent/src/runtime/compaction.ts`
- Create: `packages/agent/src/runtime/compaction.test.ts`
- Delete: `packages/agent/src/compaction.ts`
- Delete: `packages/agent/src/context/summarizing.ts`

**Actions:**
1. Make `ContextPipeline.shape()` pure over a branch snapshot: apply latest valid compaction, plugin `beforeModel` transforms, tool-result truncation, and token budgeting without a store handle.
2. Implement one explicit compaction operation shared by threshold, manual, and overflow triggers; append `CompactionEntry` without deleting original entries.
3. Allow one overflow recovery compaction and one model retry, then surface a normalized overflow failure.
4. Test that shaping never writes, compaction preserves the retained tail/tool pairs, and overflow cannot enter a compaction loop.

**Check:**

```bash
bun test packages/agent/src/context/context-pipeline.test.ts packages/agent/src/runtime/compaction.test.ts
```

Expected: shaping has zero persistence calls; proactive/manual/overflow compaction share one implementation; overflow retries at most once.

**Done when:** context shaping is observational and every durable summary is an explicit tree entry.

## Wave 4 — Freeze the plugin, todo, and skill model

### Task 8: Replace legacy hooks with static Plugin contributions

**Time box:** 25 minutes

**Files:**
- Rewrite: `packages/agent/src/runtime/plugin.ts`
- Rewrite: `packages/agent/src/runtime/plugin-dispatcher.ts`
- Create: `packages/agent/src/runtime/plugin.test.ts`
- Delete: `packages/agent/src/agent-hooks.ts`
- Delete: `packages/agent/src/hook-dispatcher.ts`

**Actions:**
1. Define one static `Plugin` shape containing only ordered hooks, tools, and Meta section providers; validate unique plugin names and tool names at session construction.
2. Remove `AgentHooks`, `createHookPlugin`, runtime context stores, init-time dynamic registration, reload, Product DB/store ports, and event aliases.
3. Await hooks in registration order; let `beforeModel` transform only the current payload and let bounded `beforeStop` veto natural stop.
4. Test deterministic ordering, validation failures, awaited hooks, pure `beforeModel`, Meta sections, and bounded stop decisions.

**Check:**

```bash
bun test packages/agent/src/runtime/plugin.test.ts
```

Expected: all plugin tests pass and no hook context exposes Product state or persistence ports.

**Done when:** the Agent Loop has one plugin API and no public/internal compatibility adapter remains.

## Wave 5 — Put every native tool behind a sandbox or port

### Task 9: Add realpath workspace containment

**Time box:** 25 minutes

**Files:**
- Create: `packages/tools-common/src/workspace-sandbox.ts`
- Create: `packages/tools-common/src/workspace-sandbox.test.ts`
- Modify: `packages/tools-common/src/file-tools.ts`
- Modify: `packages/tools-common/src/bash.ts`
- Modify: `packages/tools-common/src/glob.ts`
- Modify: `packages/tools-common/src/grep.ts`
- Modify: `packages/tools-common/src/ls-tree.ts`
- Modify: `packages/tools-common/src/index.ts`

**Actions:**
1. Canonicalize the allowed workspace root once and validate existing targets with `realpath`; for new targets validate the nearest existing parent before creation.
2. Reject `..` traversal, prefix-collision paths, absolute paths outside the root, symlink file escapes, symlink directory escapes, and command `cwd` outside the root.
3. Require each file/search/bash tool factory to receive the sandbox instead of accepting arbitrary cwd strings.
4. Add tests using temporary roots and real symlinks for read/write/edit/bash/glob/grep escape attempts and normal contained paths.

**Check:**

```bash
bun test packages/tools-common/src/workspace-sandbox.test.ts packages/tools-common/src/bash.test.ts packages/tools-common/src/glob.test.ts packages/tools-common/src/grep.test.ts
```

Expected: all contained operations pass; traversal and symlink escapes return tool errors without touching outside files.

**Done when:** lexical `startsWith(cwd)` checks no longer exist and every native filesystem/process tool shares realpath containment.


## Wave 6 — Make todo durable and skills progressive

### Task 10: Make todo durable and skills progressive

**Time box:** 30 minutes

**Files:**
- Create: `packages/agent/src/runtime/todo.ts`
- Create: `packages/agent/src/runtime/todo.test.ts`
- Rewrite: `packages/plugin-todo/src/todo.ts`
- Modify: `packages/plugin-todo/src/index.ts`
- Rewrite: `packages/plugin-todo/src/todo.test.ts`
- Modify: `packages/plugin-progressive-skill/src/cache.ts`
- Modify: `packages/plugin-progressive-skill/src/progressive-skill.ts`
- Modify: `packages/plugin-progressive-skill/src/skill-load.ts`
- Modify: `packages/plugin-progressive-skill/src/index.ts`
- Create: `packages/plugin-progressive-skill/src/progressive-skill.test.ts`

**Actions:**
1. Put todo state transitions and recovery in `packages/agent`: each update appends `TodoStateEntry`, and reopening reads the latest state on the active branch.
2. Change `plugin-todo` into a static tool/Meta contribution over the built-in todo API; remove its session maps and generic context keys rather than preserving old behavior.
3. Keep skill discovery static per Coding Session: scan configured roots for `SKILL.md`, validate frontmatter, resolve collisions deterministically, and inject only name/description in Meta.
4. Rename the tool to `skill_load`, load body text only on demand, preserve `${SKILL_DIR}` resolution, and reject root/symlink escape through the shared sandbox.
5. Test todo restart recovery, skill-index-only Meta, lazy body reads, malformed frontmatter, root precedence, missing skills, and skill path containment.

**Check:**

```bash
bun test packages/agent/src/runtime/todo.test.ts packages/plugin-todo/src/todo.test.ts packages/plugin-progressive-skill/src/progressive-skill.test.ts
```

Expected: todo survives store reopen; no skill body is read while rendering Meta; `skill_load` reads only the selected contained skill.

**Done when:** todo durability belongs to the Coding Session Tree and skills use progressive loading with no dynamic plugin reload.


### Task 11: Replace concrete web integrations with ports

**Time box:** 20 minutes

**Files:**
- Rewrite: `packages/tools-common/src/web-search.ts`
- Rewrite: `packages/tools-common/src/web-fetch.ts`
- Modify: `packages/tools-common/src/url-guard.ts`
- Modify: `packages/tools-common/src/web-search.test.ts`
- Modify: `packages/tools-common/src/web-fetch.test.ts`
- Modify: `packages/tools-common/src/index.ts`

**Actions:**
1. Define narrow `WebSearchPort` and `WebFetchPort` interfaces and factories that expose them as tools.
2. Remove Tavily API-key ownership and direct host integration from `tools-common`; keep URL validation, redirect validation, response limits, and abort propagation around injected fetch behavior.
3. Test successful delegation, port errors becoming tool errors, redirect/private-host rejection, limits, and aborts without any real network call.

**Check:**

```bash
bun test packages/tools-common/src/web-search.test.ts packages/tools-common/src/web-fetch.test.ts
bunx tsc -p packages/tools-common/tsconfig.test.json --noEmit
```

Expected: tests pass without network access and `tools-common` typechecks with no credential-bearing web factory.

**Done when:** web tools depend only on injected ports and credentials cannot enter tool definitions or events.

## Wave 7 — Install the single Agent Loop owner

### Task 12: Define loop events, commands, and settlement

**Time box:** 25 minutes

**Files:**
- Rewrite: `packages/agent/src/runtime/agent-event.ts`
- Create: `packages/agent/src/runtime/agent-loop.ts`
- Create: `packages/agent/src/runtime/agent-loop-lifecycle.test.ts`
- Delete: `packages/agent/src/runtime/create-agent.ts`
- Delete: `packages/agent/src/runtime/thread.ts`
- Delete: `packages/agent/src/runtime/trace.ts`

**Actions:**
1. Define Pi-style typed lifecycle events only: agent/turn/message/tool/retry/compaction/queue; remove old session/facade event aliases.
2. Implement `OmaSession.startLoop`, `steer`, `stop`, `compact`, and listener subscription with at most one active loop per session.
3. Dispatch and await listener promises in registration order; emit `agent_end` before waiting for its listeners, and settle only after they finish.
4. Treat a reopened session as having no active loop; do not persist resumable loop/checkpoint state.

**Check:**

```bash
bun test packages/agent/src/runtime/agent-loop-lifecycle.test.ts
```

Expected: a second simultaneous loop is rejected; listener order is stable; delayed `agent_end` listener delays settlement; reopen does not resume an active loop.

**Done when:** one object owns loop lifecycle and no Thread, Span, resume, or durable interruption concept remains.

### Task 13: Move model streaming, tool batching, queueing, and stop rules into AgentLoop

**Time box:** 30 minutes

**Files:**
- Rewrite: `packages/agent/src/runtime/span-loop.ts` as part of `packages/agent/src/runtime/agent-loop.ts`
- Rewrite: `packages/agent/src/runtime/execute-one.ts` as `packages/agent/src/runtime/tool-executor.ts`
- Modify: `packages/agent/src/runtime/repair-tool-pairs.ts`
- Create: `packages/agent/src/runtime/agent-loop-execution.test.ts`

**Actions:**
1. Move the stream/turn/tool mechanics into `AgentLoop`; append assistant and tool-result entries through `SessionStore`, and batch independent tool calls while preserving deterministic result order.
2. Enforce `maxSteps`, bounded `beforeStop` veto/force-continue, abort, and tool terminate hints in this owner.
3. Drain steer only at safe boundaries into the current loop; queue follow-up as a new loop with a fresh immutable input batch and Meta.
4. Convert tool/business failures to tool results; they must never enter provider retry logic.
5. Test streaming event order, batched tools, max steps, force continue, terminate hint, stop, steer, and follow-up behavior.

**Check:**

```bash
bun test packages/agent/src/runtime/agent-loop-execution.test.ts
```

Expected: all execution paths pass; steer stays in the current loop, follow-up creates another loop, and tool errors are visible to the model without provider retry.

**Done when:** `AgentLoop` is the only terminal/retry/queue owner and `spanLoop`/Thread mechanics no longer exist separately.

### Task 14: Add provider-only retry and credential redaction

**Time box:** 25 minutes

**Files:**
- Create: `packages/agent/src/runtime/retry.ts`
- Create: `packages/agent/src/runtime/retry.test.ts`
- Modify: `packages/agent/src/runtime/agent-loop.ts`
- Modify: `packages/agent/src/runtime/logger.ts`

**Actions:**
1. Retry only normalized transient provider errors with bounded attempts/backoff inside the same loop input snapshot.
2. Route context overflow to the one-shot compaction recovery; immediately surface auth, invalid request, fatal, aborted, and tool/business failures.
3. Redact credential/header values before errors reach logs, tree entries, or lifecycle events.
4. Test that retries do not append history/Meta/Prompt, tool errors have zero retry attempts, overflow has one recovery, and sentinel secrets appear nowhere in serialized store/events/logs.

**Check:**

```bash
bun test packages/agent/src/runtime/retry.test.ts
```

Expected: only transient provider errors retry; input counts remain unchanged; secret sentinel search is empty.

**Done when:** provider retry semantics exactly match Phase 2 and credentials cannot escape the Runtime boundary.

## Wave 8 — Delete the old public runtime and prove the package checkpoint

### Task 15: Remove legacy facade, stores, tests, dependencies, and exports

**Time box:** 25 minutes

**Files:**
- Rewrite: `packages/agent/src/index.ts`
- Modify: `packages/agent/package.json`
- Delete: `packages/agent/src/agent.ts`
- Delete: `packages/agent/src/agent-sdk.ts`
- Delete: `packages/agent/src/agent-options.ts`
- Delete: `packages/agent/src/agent-events.ts`
- Delete: `packages/agent/src/run-state.ts`
- Delete: `packages/agent/src/session-manager.ts`
- Delete: `packages/agent/src/session-manager-memory.ts`
- Delete: `packages/agent/src/persistence/message-store.ts`
- Delete: `packages/agent/src/persistence/interrupt-store.ts`
- Delete: `packages/agent/src/persistence/event-log.ts`
- Delete: `packages/agent/src/persistence/in-memory.ts`
- Delete: `packages/agent/src/agent.test.ts`
- Delete: `packages/agent/src/agent-sdk.test.ts`
- Delete: `packages/agent/src/agent-hooks.test.ts`
- Delete: `packages/agent/src/session-manager.test.ts`
- Delete: `packages/agent/src/sqlite-integration.test.ts`
- Delete: `packages/agent/src/persistence/in-memory.test.ts`
- Delete: `packages/agent/src/persistence/sqlite-persistence.test.ts`
- Delete: `packages/agent/src/persistence/session.test.ts`
- Delete: `packages/agent/src/runtime/thread.test.ts`

**Actions:**
1. Export only Coding Session/Agent Loop, SessionStore adapters/types, static Plugin types, prompt/context/compaction types, and built-in todo APIs.
2. Remove Drizzle and Zod if no new runtime file uses them; add direct workspace dependencies on `@chengchenccc/agent-backend`, `@chengchenccc/ai`, and `@chengchenccc/tools-common` as actually imported.
3. Delete all legacy implementations and compatibility-focused tests; do not replace them with aliases or negative runtime shims.
4. Add a compile-time export-surface test proving new exports work and old names cannot be imported.

**Check:**

```bash
! grep -R -E 'export .*\b(Agent|AgentSDK|createAgentSession|SessionManager|MessageStore|InterruptStore)\b' packages/agent/src/index.ts
bunx tsc -p packages/agent/tsconfig.test.json --noEmit
```

Expected: grep exits successfully because no forbidden export exists; `packages/agent` typechecks independently. Downstream Product packages may fail and are not touched.

**Done when:** old Runtime APIs and storage paths are physically absent, not deprecated or redirected.

### Task 16: Add the complete single-process acceptance harness

**Time box:** 30 minutes

**Files:**
- Create: `packages/agent/src/runtime/oma-harness.test.ts`
- Modify only if required by failures: files created or rewritten in Tasks 1–15

**Actions:**
1. Build a deterministic fake `ModelRuntime`, static Plugin set, sandboxed tools, in-memory/SQLite store factory, captured listeners, and fake Product history/snapshot.
2. Run an end-to-end loop that receives history + Meta + Prompt, streams assistant tool calls, executes tools, persists todo, compacts, steers, completes, reopens, and starts a follow-up loop.
3. Run the same scenario against both stores and assert equal observable branch/event/outcome behavior.
4. Assert no active-loop recovery after simulated crash/reopen and no Product DB, Agent Context, Product Memory, or credential object is reachable from Runtime ports.

**Check:**

```bash
bun test packages/agent/src/runtime/oma-harness.test.ts
```

Expected: both memory and SQLite scenarios complete with identical outcomes; reopen restores completed branch/todo only and starts no loop.

**Done when:** Oma Runtime core executes a complete Agent Loop in one process with every Phase 2 invariant observable in the harness.

## Final phase gate — Phase 2 only

**Destructive checkpoint:** Do not proceed to Phase 3 if any old facade/store/export exists, any retry duplicates loop input, or either SessionStore adapter diverges. Do not repair Product caller failures here.

Run exactly these focused commands:

```bash
bun test packages/ai/src
bun test packages/tools-common/src
bun test packages/plugin-todo/src packages/plugin-progressive-skill/src
bun test packages/agent/src
bunx tsc -p packages/ai/tsconfig.test.json --noEmit
bunx tsc -p packages/tools-common/tsconfig.test.json --noEmit
bunx tsc -p packages/plugin-todo/tsconfig.test.json --noEmit
bunx tsc -p packages/plugin-progressive-skill/tsconfig.test.json --noEmit
bunx tsc -p packages/agent/tsconfig.test.json --noEmit
! grep -R -E '\b(AgentSDK|createAgentSession|SessionManager|MessageStore|InterruptStore|ModelChangeEntry)\b' packages/agent/src packages/ai/src
! grep -R -E 'checkpoint_(messages|interrupts|events)|legacy compatibility|backward compat' packages/agent/src
```

Expected result:

- All five focused package test/typecheck groups pass.
- InMemory and SQLite execute the same shared SessionStore suite.
- Anthropic and OpenAI-compatible provider contract tests pass.
- Traversal and symlink escape tests pass.
- Harness assertions cover atomic/idempotent loop input, one Meta per loop, System Prompt exclusion, pure shaping, one-shot overflow recovery, provider-only retry, awaited listeners, crash non-resume, todo recovery, and lazy skill bodies.
- Both destructive grep checks exit 0 because forbidden legacy symbols/tables/compatibility text are absent.
- No command builds or typechecks `apps/backend` or other Product callers; their cutover remains Phase 5.

**Phase 2 is done when:** the focused gate passes, the single-process harness completes against both stores, and inspection finds no compatibility path or Product caller migration.