# Phase 6: Only the New Execution Model Remains

## Goal

Delete every legacy Product execution/checkpoint path after Phase 5 so Agent Run → Agent Backend → Coding Agent is the only execution model.

## Outcome

Active source, schema, routes, config, packages, scripts, operations, and current docs contain no legacy execution entry. Conversation History, Agent Context, Context Branch, Agent Run, and useful reader-backed audit data remain intact.

## Prerequisites

- Phases 0–5 are complete in programme order.
- Phase 5 full-repository build/typecheck/lint gate is green.
- All Product callers already create Agent Runs; this phase does not cut traffic.
- A disposable pre-Phase-6 `backend.db` fixture exists for migration verification.
- Old `checkpointer.db` files and checkpoint rows are expendable execution cache.

## Non-goals

- No new product behavior or Agent Backend contract changes.
- No old session/checkpoint import, redirect, alias, shim, dual read, or dual write.
- No conversion of checkpoint data into Agent Context.
- No deletion of Product facts or useful audit records with a live reader.
- Historical ADRs, specs, plans, migrations, and explicit tombstones may retain old names.

## Estimated size

4–6 engineer-days. Seven sequential waves. Do not parallelize destructive waves.

## Wave 1 — Prove the deletion boundary

### Task 1.1: Confirm Phase 5 is actually complete

**Time box:** 20 minutes

**Files:**

- Inspect: `docs/superpowers/specs/agent-backend-coding-agent-rewrite/phase-5-product-caller-cutover.md`
- Create: `scripts/smoke-agent-run.ts`
- Modify: `apps/backend/src/infra/sqlite/db.test.ts`

**Actions:**

1. Confirm Conversation, Cron, Loop, Skill Pack, Web, and Lark use Agent Runs; run the Phase 5 clean search.
2. Add an upgraded-DB fixture assertion recording Product History/Context/Run/audit keys and counts before any Phase 6 deletion.
3. Create an authenticated smoke script that posts a Message, waits for terminal Agent Run, verifies one History Message + Context ref, stops the Worker, and starts the next Run.
4. Run the script once on a clean data dir and once on the upgraded fixture.
5. Stop and finish Phase 5 if any legacy caller or smoke failure remains.

**Check:**

```bash
! grep -RInE '@my-agent-team/agent|createAgentSession|SessionManager|ConversationLock|activeSessions|member\.sessionId|checkpointer\.db' apps/backend/src
bun test apps/backend/src/infra/sqlite/db.test.ts
bun run scripts/smoke-agent-run.ts --mode clean
bun run scripts/smoke-agent-run.ts --mode upgraded-fixture
```
Expected: search is zero; Product-fact baseline test and both smoke modes pass.

**Done when:** Phase 6 starts from a green cutover with executable Product-fact preservation and happy-path/rebuild proof.

### Task 1.2: Inventory runtime and package imports

**Time box:** 30 minutes

**Files:**

- Inspect: `packages/core/src/`
- Inspect: `packages/agent/src/`
- Inspect: `packages/plugin-*/`
- Inspect: `apps/*/package.json`
- Inspect: `packages/*/package.json`
- Inspect: `tsconfig.json`
- Inspect: `bun.lock`

**Actions:**

1. List importers of `@my-agent-team/agent`, every plugin package, and `run`/`RunOptions` from core.
2. Classify each plugin as statically owned by the Phase 2 Coding Agent or unowned.
3. Classify `packages/core/src/run.ts` separately from still-live `ChatModel`, `Tool`, message-block, and stream utilities.
4. Record deletion targets in the working transcript; do not add a permanent inventory file.

**Check:**

```bash
grep -RInE 'from ["'"']@my-agent-team/(agent|plugin-[^"'"']+)["'"']|\bRunOptions\b' apps packages --include='*.ts' --include='*.tsx'
grep -RInE '"@my-agent-team/(agent|plugin-[^"]+|core)"' apps/*/package.json packages/*/package.json
```

Expected: every hit has a current Coding Agent owner or a deletion task below.

**Done when:** No runtime/package deletion depends on guessed ownership.

### Task 1.3: Inventory storage, routes, config, and audit readers

**Time box:** 30 minutes

**Files:**

- Inspect: `apps/backend/src/infra/db/schema.ts`
- Inspect: `apps/backend/drizzle/backend/`
- Inspect: `packages/agent/drizzle/`
- Inspect: `apps/backend/src/features/runtime-ops/`
- Inspect: `apps/backend/src/features/span/`
- Inspect: `apps/backend/src/features/settings/`
- Inspect: `packages/config/src/env.ts`
- Inspect: `scripts/`

**Actions:**

1. Trace all creators/readers of `checkpointer.db` and `checkpoint_*` tables.
2. Trace `member.session_id`, span/attempt/origin/control-plane tables, and every active reader.
3. Retain audit data only when a post-Phase-5 reader exists; Agent Run remains terminal authority.
4. List old resume/interrupt/session/span/attempt routes and Web/Lark/API clients.

**Check:**

```bash
grep -RInE 'checkpointer\.db|checkpoint_messages|checkpoint_interrupts|checkpoint_events|session_id|/api/.+(resume|interrupt|sessions|spans|attempts)' apps packages scripts --exclude-dir=dist --exclude-dir=.next
grep -RInE '\b(span|attempt|span_origin|control_plane_event)\b' apps/backend/src apps/web/src apps/lark-bot/src packages/api-contract/src
```

Expected: every active hit is assigned to Waves 3 or 4; every retained audit table has a named reader.

**Done when:** Storage and API deletion boundaries are explicit.

## Wave 2 — Delete the old runtime owner

### Task 2.1: Delete the second core Agent Loop

**Time box:** 20 minutes

**Files:**

- Delete: `packages/core/src/run.ts`
- Delete: `packages/core/src/run.test.ts`
- Modify: `packages/core/src/index.ts`
- Modify/delete: `packages/core/README.md`

**Actions:**

1. Re-run the `run`/`RunOptions` importer search.
2. Delete the loop and tests.
3. Remove only its exports; keep live contracts/utilities.
4. Remove README claims that core owns an Agent Loop.

**Check:**

```bash
! grep -RInE '\bRunOptions\b|@my-agent-team/core.*\brun\b' apps packages --include='*.ts' --include='*.tsx'
bun run --cwd packages/core typecheck
bun run --cwd packages/core test
```

Expected: search is zero; package gates pass.

**Done when:** Coding Agent owns the only Agent Loop.

### Task 2.2: Delete legacy facade, stores, and checkpoint persistence

**Time box:** 30 minutes

**Files:**

- Delete after zero-import proof: legacy facade files under `packages/agent/src/` (`agent.ts`, `agent-sdk.ts`, `agent-hooks.ts`, `hook-dispatcher.ts`, `session-manager*.ts`, old options/events/state and tests)
- Delete after zero-import proof: flat checkpoint/store files under `packages/agent/src/persistence/`
- Delete: `packages/agent/drizzle/`
- Modify: `packages/agent/src/index.ts`
- Modify: `packages/agent/package.json`

**Actions:**

1. Compare current files with Phase 2; preserve the new Coding Session Tree/SessionStore.
2. Delete public `Agent`, `createAgentSession`, `AgentHooks`, `SessionManager`, flat Message/Interrupt/Event stores, and compatibility tests.
3. Delete checkpoint schema/migrations and old-data readers.
4. Remove dependencies used only by deleted code; add no aliases or forwarders.

**Check:**

```bash
! grep -RInE 'createAgentSession|SessionManager|AgentHooks|checkpoint_messages|checkpoint_interrupts|checkpoint_events|legacy compatibility' packages/agent/src packages/agent/package.json
! test -d packages/agent/drizzle
bun run --cwd packages/agent typecheck
bun run --cwd packages/agent test
```

Expected: searches are zero; old drizzle directory is absent; new Coding Agent runtime passes.

**Done when:** `packages/agent` contains only Phase 2 Worker-local Coding Agent code.

### Task 2.3: Delete unowned Product runtime plugin packages

**Time box:** 30 minutes

**Files:**

- Delete only after zero-import proof: `packages/plugin-conversation-context/`
- Delete only after zero-import proof: `packages/plugin-goal/`
- Delete only after zero-import proof: `packages/plugin-pet/`
- Delete only after zero-import proof: `packages/plugin-recap/`
- Delete any other plugin package without a Phase 2 Coding Agent owner
- Preserve or fold only plugins still statically loaded by Coding Agent

**Actions:**

1. Re-run source and manifest searches per package.
2. Delete zero-owner directories; do not keep empty workspace shells.
3. If behavior moved into Coding Agent, migrate the final importer first.
4. Do not move Product Conversation state or Product Tool closures into Coding Agent plugins.

**Check:**

```bash
for p in plugin-conversation-context plugin-goal plugin-pet plugin-recap; do
  ! grep -RIn "@my-agent-team/$p" apps packages --include='*.ts' --include='*.tsx' --include='package.json' --exclude-dir="$p"
done
```

Expected: every deleted package has zero live importer.

**Done when:** No unowned legacy plugin package remains.

### Task 2.4: Runtime destructive checkpoint

**Time box:** 20 minutes

**Files:**

- Verify: `packages/agent/`
- Verify: `packages/core/`
- Verify: surviving plugins
- Verify: `apps/coding-agent/`
- Verify: `packages/adapter-coding-agent/`

**Actions:**

1. Run focused new-runtime tests.
2. Search active runtime source for removed public symbols and checkpoint tables.
3. Review any additional loop-shaped implementation by filename and owner.

**Check:**

```bash
! grep -RInE 'createAgentSession|SessionManager|AgentHooks|checkpoint_messages|checkpoint_interrupts|checkpoint_events|ProductTurn|SelfHosted|runtimeSessionId' packages/*/src apps/coding-agent/src
bun run --cwd packages/agent test
bun run --cwd apps/coding-agent test
bun run --cwd packages/adapter-coding-agent test
```

Expected: search is zero; all focused tests pass.

**Done when:** **DESTRUCTIVE CHECKPOINT A:** old runtime code is gone and Coding Agent still runs independently.

## Wave 3 — Delete backend checkpoint and legacy execution surfaces

### Task 3.1: Remove checkpointer bootstrap/config/settings

**Time box:** 25 minutes

**Files:**

- Modify: `apps/backend/src/bootstrap/services.ts`
- Modify: `apps/backend/src/bootstrap/services.test.ts`
- Modify: `apps/backend/src/bootstrap/features.ts`
- Modify: `apps/backend/src/bootstrap/features.test.ts`
- Modify: `apps/backend/src/features/settings/service.ts`
- Modify: `apps/backend/src/features/settings/service.test.ts`
- Modify if stale fields exist: `apps/backend/src/config.ts`
- Modify if stale fields exist: `packages/config/src/env.ts`
- Modify: `apps/backend/.env.example`

**Actions:**

1. Remove session-manager/checkpointer construction, service fields, lifecycle hooks, and tests.
2. Remove readonly checkpoint event-store opening and fallback.
3. Remove checkpoint path/config exposure.
4. Preserve Agent Backend registry/pool, Agent Run, Product Tool, daemon client, and shutdown order.

**Check:**

```bash
! grep -RInE 'checkpointer|SessionManager|SqliteSessionManager|sessionManager' apps/backend/src/bootstrap apps/backend/src/config.ts apps/backend/src/features/settings packages/config/src apps/backend/.env.example
bun run --cwd apps/backend test
```

Expected: search is zero; backend tests pass without creating `checkpointer.db`.

**Done when:** Product Backend neither configures nor opens legacy runtime persistence.

### Task 3.2: Delete checkpoint event readers; keep only useful audit

**Time box:** 30 minutes

**Files:**

- Delete: `apps/backend/src/features/runtime-ops/checkpoint-events-store.ts`
- Delete: `apps/backend/src/features/runtime-ops/checkpoint-events-store.test.ts`
- Modify: `apps/backend/src/features/runtime-ops/service.ts`
- Modify: `apps/backend/src/features/runtime-ops/insights.ts`
- Modify: `apps/backend/src/features/runtime-ops/store.ts`
- Modify: `apps/backend/src/features/runtime-ops/types.ts`
- Modify: `apps/backend/src/features/runtime-ops/index.ts`
- Modify adjacent tests
- Modify if contract changes: `apps/web/src/app/(main)/work/page.tsx`

**Actions:**

1. Delete checkpoint event store and tests.
2. Source useful ops/insights from Agent Run and retained audit/Product Tool audit records, or remove the field.
3. Keep span/attempt only with a live audit reader; remove terminal/recovery decisions based on them.
4. Update tests to assert Agent Run authority.

**Check:**

```bash
! grep -RInE 'CheckpointEventsStore|createCheckpointEventsStore|checkpoint_events|heartbeat_timeout' apps/backend/src apps/web/src
bun test apps/backend/src/features/runtime-ops
```

Expected: search is zero; ops tests pass with Agent Run status plus explicit audit.

**Done when:** Ops has no checkpoint reader or legacy terminal authority.

### Task 3.3: Delete old routes and clients

**Time box:** 25 minutes

**Files:**

- Delete: `apps/backend/src/features/span/http.ts`
- Modify: `apps/backend/src/app.ts`
- Modify: `apps/backend/src/bootstrap/features.ts`
- Modify: `apps/backend/src/features/runtime-ops/http.ts`
- Modify: `packages/api-contract/src/`
- Modify: `apps/web/src/`
- Modify: `apps/lark-bot/src/`

**Actions:**

1. Delete old resume/interrupt/session endpoints; PendingAction uses Agent Run APIs.
2. Remove route types/composition and tests.
3. Remove span/attempt routes unless explicitly retained as Agent Run audit subresources.
4. Update Web, Lark, and API contract in the same task; add no aliases.

**Check:**

```bash
! grep -RInE '/api/runs/:id/resume|resumeRoutes|/api/.+(interrupt|sessions|spans|attempts)' apps/backend/src apps/web/src apps/lark-bot/src packages/api-contract/src
bun run --cwd apps/backend typecheck
bun run --cwd apps/web typecheck
bun run --cwd apps/lark-bot typecheck
```

Expected: removed routes have zero callsite; consumers compile.

**Done when:** No HTTP path can enter the old session/checkpoint lifecycle.

### Task 3.4: Delete old supervisor and direct runtime assembly

**Time box:** 30 minutes

**Files:**

- Delete after zero-import proof: `apps/backend/src/features/span/supervisor.ts`
- Delete: `apps/backend/src/features/span/session-manager.test.ts`
- Delete after zero-import proof: `apps/backend/src/features/span/agent-helpers.ts`
- Modify/delete: `apps/backend/src/features/span/index.ts`
- Modify: `apps/backend/src/main.ts`
- Modify: `apps/backend/src/bootstrap/services.ts`
- Modify: `apps/backend/src/bootstrap/features.ts`

**Actions:**

1. Prove Agent Run execution replaced supervisor start/complete/reaper/cancel ownership.
2. Delete supervisor and direct Provider/runtime/plugin assembly helpers.
3. Remove supervisor shutdown; retain Pool/Adapter/daemon-client shutdown.
4. Delete `features/span` if no audit-only implementation remains.

**Check:**

```bash
! grep -RInE 'SpanSupervisor|features/span|startSpan\(|notifyRunComplete|createDefaultModelRegistry|defaultPlugins|defaultContextManager' apps/backend/src
bun run --cwd apps/backend typecheck
bun run --cwd apps/backend test
```

Expected: search is zero; backend passes.

**Done when:** **DESTRUCTIVE CHECKPOINT B:** Product Backend has no local legacy execution facade.

## Wave 4 — Drop old cache/schema; preserve Product facts

### Task 4.1: Extend the passing preservation fixture

**Time box:** 25 minutes

**Files:**

- Modify: `apps/backend/src/infra/sqlite/db.test.ts`
- Inspect: `apps/backend/src/infra/db/schema.ts`

**Actions:**

1. Reuse the passing upgraded-DB fixture created in Task 1.1.
2. Assert exact Product fact keys/counts before migration and record obsolete columns/tables separately.
3. Assert checkpoint data is not represented in Agent Context.
4. Keep this card green against the pre-deletion schema; post-migration disappearance assertions belong to Task 4.2.

**Check:**

```bash
bun test apps/backend/src/infra/sqlite/db.test.ts
```

Expected: baseline Product fact and non-conversion assertions pass before destructive SQL.

**Done when:** the preservation baseline is green and Task 4.2 can measure only intended deletion.

### Task 4.2: Drop `member.session_id` and unread legacy tables

**Time box:** 30 minutes

**Files:**

- Modify: `apps/backend/src/infra/db/schema.ts`
- Create: `apps/backend/drizzle/backend/<next-migration>.sql`
- Modify: `apps/backend/drizzle/backend/meta/_journal.json`
- Create/update: latest backend snapshot
- Modify any stale member adapter/port tests

**Actions:**

1. Remove `member.sessionId` and residual binding APIs.
2. Recreate `member` without `session_id`, preserving rows, foreign keys, and indexes.
3. Drop span/attempt/origin/control-plane objects only when Wave 1 proved no reader; otherwise retain them as audit linked to Agent Run.
4. Never copy old session IDs or checkpoint rows into new bindings/context.

**Check:**

```bash
bun run --cwd apps/backend db:check:backend
bun test apps/backend/src/infra/sqlite/db.test.ts
```

Expected: migration check passes; old fixture preserves Product facts; fresh DB lacks `member.session_id`.

**Done when:** Product schema contains no old session binding and no unread legacy table.

### Task 4.3: Remove checkpoint migration/bootstrap ownership

**Time box:** 20 minutes

**Files:**

- Modify: `scripts/predev.sh`
- Modify: `scripts/gen-drizzle.sh`
- Modify if needed: `.gitignore`
- Delete remaining obsolete checkpoint migration config/files

**Actions:**

1. Remove creation, migration, validation, and readiness checks for checkpoint storage.
2. Remove stale framework/agent checkpoint paths from scripts.
3. Do not add an import/cleanup utility to product code.
4. Verify an old external `checkpointer.db` is ignored, not opened or mutated.

**Check:**

```bash
! grep -RInE 'checkpointer\.db|checkpoint_messages|checkpoint_interrupts|checkpoint_events' apps packages scripts --exclude-dir=drizzle --exclude='*.md'
bash -n scripts/predev.sh scripts/gen-drizzle.sh
```

Expected: active code/script search is zero; scripts parse.

**Done when:** Old execution cache has no runtime owner.

### Task 4.4: Prove next-run rebuild without checkpoint data

**Time box:** 30 minutes

**Files:**

- Modify/add: `apps/backend/src/features/agent-run/execution.test.ts`
- Modify/add tests under: `apps/backend/src/features/agent-context/`
- Modify: `apps/backend/src/infra/sqlite/db.test.ts`

**Actions:**

1. Use migrated Product facts with no checkpoint DB/cache.
2. Start the next Agent Run and force rebuild instead of resume.
3. Assert stable Product entry IDs and one semantic input.
4. Assert Conversation replay and Product facts are unchanged.

**Check:**

```bash
bun test apps/backend/src/features/agent-context apps/backend/src/features/agent-run/execution.test.ts apps/backend/src/infra/sqlite/db.test.ts
```

Expected: next Run rebuilds from Product facts only.

**Done when:** **DESTRUCTIVE CHECKPOINT C:** deleting old cache cannot break replay or the next Agent Run.

## Wave 5 — Delete or tombstone obsolete current docs

### Task 5.1: Remove old runtime/framework/harness guidance

**Time box:** 25 minutes

**Files:**

- Delete or tombstone: `docs/architecture/runtime/framework.md`
- Delete or tombstone: `docs/architecture/runtime/context-manager.md`
- Delete or tombstone: `docs/architecture/runtime/plugin.md`
- Delete or tombstone: `docs/architecture/harness/harness.md`
- Preserve/update: `docs/architecture/runtime/coding-agent*.md`
- Preserve/update: `docs/architecture/execution/agent-backend.md`

**Actions:**

1. Delete pages fully replaced by Coding Agent/Agent Backend docs.
2. Use a short `status: deprecated` tombstone only for durable incoming links.
3. Remove obsolete implementation instructions from tombstones.
4. Remove claims that Product Backend owns Agent Loop, session, plugins, compaction, Provider SDK, or checkpoint storage.

**Check:**

```bash
grep -RInE 'createAgentSession|SessionManager|AgentHooks|checkpointer|checkpoint_' docs/architecture/runtime docs/architecture/harness || true
```

Expected: hits exist only in short, explicit deprecated tombstones.

**Done when:** Coding Agent and Agent Backend are the only current execution narrative.

### Task 5.2: Rewrite operations/backend guidance

**Time box:** 25 minutes

**Files:**

- Modify: `docs/architecture/operations/troubleshooting.md`
- Delete/rewrite: `docs/architecture/backend/event-log.md`
- Modify: `docs/architecture/backend/loop-runner.md`
- Modify: `docs/architecture/backend/overview.md`
- Modify: `docs/architecture/backend/data-model.md`
- Modify: `docs/architecture/runs/output-and-live-updates.md`
- Modify: `docs/architecture/foundations/facts-and-projections.md`
- Modify: `docs/architecture/foundations/identifiers.md`
- Modify: `docs/architecture/foundations/lifecycle-overview.md`

**Actions:**

1. Diagnose Agent Run, queue, branch ownership, Backend outcome, `commit_failed`, daemon, Worker, and retained audit.
2. Remove checkpoint/session/span terminal troubleshooting.
3. Describe span/attempt only as audit when retained.
4. Update Loop Generator/Evaluator to create Agent Runs, not sessions.

**Check:**

```bash
! grep -RInE 'createAgentSession|SessionManager|checkpointer\.db|checkpoint_messages|checkpoint_interrupts|checkpoint_events|span.*terminal|attempt.*terminal' docs/architecture/operations docs/architecture/backend docs/architecture/runs docs/architecture/foundations
```

Expected: zero active guidance hits; any tombstone is manually excluded and reviewed.

**Done when:** Operations teaches only the new control plane.

### Task 5.3: Update entry points and indexes

**Time box:** 30 minutes

**Files:**

- Modify: `README.md`
- Modify: `apps/backend/README.md`
- Modify/create if present in Phase 3: `apps/coding-agent/README.md`
- Modify: `docs/architecture/README.md`
- Modify: `docs/architecture/index.llm.md`
- Modify: `docs/architecture/map.md`
- Modify: `docs/architecture/concepts.json`
- Modify: `docs/architecture/MANIFEST.md`
- Modify: `CONTEXT.md` if maintained as current guidance

**Actions:**

1. Replace in-process/checkpointer diagrams with Product Backend → Agent Run → Agent Backend → Coding Agent.
2. Describe `backend.db` Product facts and disposable daemon-owned Coding Session storage.
3. Remove deleted packages/pages and add new rewrite packages/apps.
4. Verify every `concepts.json` path exists.
5. Use public domain names; keep technical names in implementation details only.

**Check:**

```bash
! grep -RInE 'AgentSession|createAgentSession|SessionManager|checkpointer\.db|checkpoint_messages|checkpoint_interrupts|checkpoint_events|SelfHosted|ProductTurn|runtimeSessionId' README.md apps/*/README.md CONTEXT.md docs/architecture/README.md docs/architecture/index.llm.md docs/architecture/map.md docs/architecture/concepts.json docs/architecture/MANIFEST.md
bun -e 'const c=await Bun.file("docs/architecture/concepts.json").json(); for (const x of c.concepts) if (!(await Bun.file(x.path).exists())) throw new Error(`missing ${x.path}`); console.log("concept paths OK")'
```

Expected: search is zero; checker prints `concept paths OK`.

**Done when:** **DESTRUCTIVE CHECKPOINT D:** no current entry point leads to old execution.

## Wave 6 — Clean package and workspace graphs

### Task 6.1: Remove deleted manifest/export edges

**Time box:** 25 minutes

**Files:**

- Modify: `apps/backend/package.json`
- Modify: other `apps/*/package.json`
- Modify: surviving `packages/*/package.json`
- Modify: `package.json` only for stale scripts

**Actions:**

1. Remove deleted plugin and Product Backend runtime dependencies.
2. Remove dependencies used only by deleted files.
3. Remove stale exports/files/scripts.
4. Keep `@my-agent-team/agent` only if it remains the real Phase 2 runtime and only in Coding Agent-owned manifests.

**Check:**

```bash
grep -RInE '"@my-agent-team/(agent|plugin-conversation-context|plugin-goal|plugin-pet|plugin-recap)"' apps/*/package.json packages/*/package.json || true
```

Expected: every remaining hit has a current Coding Agent source importer.

**Done when:** Manifest edges exactly match live imports.

### Task 6.2: Clean TypeScript/Turbo/dev graph

**Time box:** 25 minutes

**Files:**

- Modify: `tsconfig.json`
- Modify if stale: `tsconfig.base.json`
- Modify if stale: `turbo.json`
- Modify: `scripts/predev.sh`
- Modify: `scripts/gen-drizzle.sh`
- Modify: `scripts/dev.sh`
- Modify: Coding Agent process/deployment config
- Modify: `commitlint.config.mjs`

**Actions:**

1. Remove references to deleted packages and stale `framework`/`harness` paths.
2. Keep only real migration targets.
3. Make dev start/stop backend, Coding Agent daemon, and surfaces together.
4. Remove old in-process/runner-registry comments; add no orchestration abstraction.

**Check:**

```bash
! grep -RInE 'packages/(framework|harness)|checkpointer|checkpoint_|plugin-(conversation-context|goal|pet|recap)' tsconfig*.json turbo.json scripts commitlint.config.mjs
bash -n scripts/predev.sh scripts/gen-drizzle.sh scripts/dev.sh
```

Expected: search is zero; scripts parse.

**Done when:** Workspace tooling knows only the surviving graph.

### Task 6.3: Regenerate lockfile

**Time box:** 20 minutes

**Files:**

- Modify: `bun.lock`

**Actions:**

1. Run `bun install` once after package deletion.
2. Search lockfile for deleted package stanzas.
3. List all packages and resolve missing workspace dependencies.
4. Do not hand-edit the lockfile.

**Check:**

```bash
bun install
! grep -nE 'packages/(plugin-conversation-context|plugin-goal|plugin-pet|plugin-recap)|@my-agent-team/(plugin-conversation-context|plugin-goal|plugin-pet|plugin-recap)' bun.lock
bun pm ls --all
```

Expected: install and listing succeed; lockfile search is zero.

**Done when:** No ghost package or empty shell remains.

### Task 6.4: Exact active search gate

**Time box:** 20 minutes

**Files:**

- Verify: active source/config/scripts/manifests/current docs
- Exclude: historical ADRs/specs/plans/migrations and explicit tombstones

**Actions:**

1. Run source/config forbidden-symbol search.
2. Run current-doc search separately.
3. Run deleted-package search.
4. Explain or remove every hit before continuing.

**Check:**

```bash
! grep -RInE 'checkpointer\.db|checkpoint_messages|checkpoint_interrupts|createAgentSession|SessionManager|AgentHooks|runtimeSessionId|ProductTurn|SelfHosted' apps/*/src packages/*/src scripts package.json tsconfig*.json turbo.json
! grep -RInE 'checkpointer\.db|checkpoint_messages|checkpoint_interrupts|createAgentSession|SessionManager|AgentHooks|runtimeSessionId|ProductTurn|SelfHosted' README.md apps/*/README.md packages/*/README.md docs/architecture
! grep -RInE 'plugin-(conversation-context|goal|pet|recap)' apps/*/package.json packages/*/package.json tsconfig.json bun.lock
```

Expected: all searches are zero after explicitly excluding known tombstones from the second command when necessary.

**Done when:** **DESTRUCTIVE CHECKPOINT E:** active repository graph contains no legacy entry.

## Wave 7 — Sequential full gates and smoke test

### Task 7.1: Verify fresh and upgraded databases

**Time box:** 25 minutes

**Files:**

- Verify: `apps/backend/src/infra/sqlite/db.test.ts`
- Verify: latest backend migration
- Verify: Agent Context/Agent Run tests

**Actions:**

1. Create a fresh Product DB and inspect tables/columns.
2. Upgrade the old fixture and verify preserved Product/audit assertions.
3. Confirm no checkpoint DB/table is required or created.
4. Confirm Conversation replay is unchanged.

**Check:**

```bash
bun run --cwd apps/backend db:check:backend
bun test apps/backend/src/infra/sqlite/db.test.ts apps/backend/src/features/agent-context apps/backend/src/features/agent-run
```

Expected: fresh schema has no checkpoint tables/member session column; upgraded facts survive.

**Done when:** Destructive data cleanup is proven safe for Product facts.

### Task 7.2: Run full gates in required order

**Time box:** 60 minutes

**Files:**

- Verify: entire repository

**Actions:**

1. Run each command only after the previous passes.
2. Fix root causes without exclusions or suppressions.
3. Restart from `build` after any source/config/manifest/migration fix.

**Check:**

```bash
bun run build
bun run typecheck
bun run lint
bun test
bun run test
```

Expected: all five pass sequentially.

**Done when:** Repository-wide Phase 6 gates are green.

### Task 7.3: Smoke the only happy path

**Time box:** 30 minutes

**Files:**

- Execute: `scripts/smoke-agent-run.ts`
- Exercise: `apps/coding-agent/`
- Exercise: `apps/backend/`

**Actions:**

1. Start Coding Agent and Backend with the script's documented environment.
2. Post an authenticated Conversation Message and wait for terminal Agent Run.
3. Assert Live Updates were observed and exactly one History Message + Context ref + terminal Run were committed.
4. Stop the Worker/session; post the next Message and assert resume-if-valid or rebuild from Product facts.
5. Assert one Product Tool call has authorization and audit records.

**Check:**

```bash
bun run scripts/smoke-agent-run.ts --mode clean
bun run scripts/smoke-agent-run.ts --mode upgraded-fixture
```

Expected: both modes print the complete Message → Run → Backend → Worker → outcome → atomic commit → next-run recovery sequence and exit 0.


**Done when:** End to end, only Agent Run + Agent Backend + Coding Agent executes work.

### Task 7.4: Smoke failure and recovery

**Time box:** 30 minutes

**Files:**

- Exercise: Backend/daemon processes
- Inspect: Agent Run, queue, branch ownership, Product Tool audit, Conversation History

**Actions:**

1. Stop daemon before dispatch; verify explicit failed/unsupported Agent Run and no false success Message.
2. Run two sessions; crash one Worker; verify the other continues and crashed Run fails.
3. Trigger `commit_failed`; restart Backend; verify replay while branch remains owned until commit succeeds.
4. Disconnect Web/Lark; verify canonical terminal result still commits.
5. Repeat the active search gate after fixes.

**Check:**

```bash
bun test apps/backend/src/features/agent-run/execution.test.ts apps/backend/src/features/product-tools apps/coding-agent/src/session-supervisor.test.ts
! grep -RInE 'checkpointer\.db|checkpoint_messages|checkpoint_interrupts|createAgentSession|SessionManager|AgentHooks|runtimeSessionId|ProductTurn|SelfHosted' apps/*/src packages/*/src scripts
```

Expected: daemon unavailable, isolated crash, Product Tool audit, restart, and `commit_failed` recovery pass; search remains zero.

**Done when:** No failure path falls back to legacy execution.

## Final phase gate

Run exactly in this order:

```bash
! grep -RInE 'checkpointer\.db|checkpoint_messages|checkpoint_interrupts|createAgentSession|SessionManager|AgentHooks|runtimeSessionId|ProductTurn|SelfHosted' apps/*/src packages/*/src scripts package.json tsconfig*.json turbo.json
bun run --cwd apps/backend db:check:backend
bun run build
bun run typecheck
bun run lint
bun test
bun run test
```

Expected: search is zero and every command exits 0. Then repeat Task 7.3 once with a clean data directory and once with the upgraded fixture.

**Phase complete when:**

- Agent Run is the only Product execution control plane.
- Coding Agent owns the only Agent Loop/Coding Session runtime.
- Product Backend has no legacy facade, Provider/runtime assembly, checkpoint store, old plugin assembly, or old route.
- Product facts and useful audit survive; execution cache is deleted without conversion.
- No package/config/script/current-doc edge points to the old model.
- Happy path, daemon unavailable, isolated Worker crash, Product Tool authorization/audit, Backend restart, and `commit_failed` recovery all pass.
