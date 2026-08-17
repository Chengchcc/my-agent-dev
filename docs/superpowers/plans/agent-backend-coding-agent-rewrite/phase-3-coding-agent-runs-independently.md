# Phase 3 — Oma Runs Independently Implementation Plan

**Goal:** Deploy the Oma as an independent, authenticated Agent Backend service with one Worker process per active Agent Run. Session continuity is guaranteed by the SQLite `SessionStore`, never by a resident Worker process.

**Outcome:** `apps/oh-my-agent` owns one-shot Worker lifecycle (spawn per Run, execute, emit one outcome, exit), NDJSON IPC, bounded event replay, model catalog publication, and Product Tool MCP connectivity; `packages/adapter-oma-agent` implements the exact `AgentBackend` method set `start/send/resume/respond/stop/close` over HTTP + SSE. A real Adapter contract test completes an Agent Run in a Worker without Product Backend caller cutover.

**Prerequisites:** Phase 0 `@chengchenccc/agent-backend` contracts compile; Phase 2 exposes the Oma Runtime, SQLite `SessionStore`, `ModelRuntime`, runtime event types, and Worker-safe construction APIs. Read `docs/superpowers/specs/agent-backend-oma-rewrite/phase-3-oma-service.md`, `docs/architecture/execution/agent-backend.md`, `docs/architecture/runtime/oma.md`, `docs/architecture/runtime/oma-session.md`, and `docs/architecture/runtime/oma-models.md` before implementation.

**Non-goals:** Do not modify Product Backend execution or callers; that begins in Phase 4 and caller cutover remains Phase 5. Do not add an in-process Runtime fallback, old checkpointer/session migration, a `respond` HTTP endpoint, pending continuation state, worker-crash active-loop recovery, dual transport, provider credentials in Product Backend, or a daemon session catalog database.

**Estimated size:** 28 bounded task cards, approximately 11–14 focused engineering hours.

> **Execution rule:** Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Keep each card bounded. Run only the card’s focused command before moving on.

---

## Wave 1 — Create the two deployable workspace units

### Task 1.1 — Scaffold the Oma service package

**Time box:** 20 minutes

**Files:**
- Create: `apps/oh-my-agent/package.json`
- Create: `apps/oh-my-agent/tsconfig.json`
- Create: `apps/oh-my-agent/tsconfig.test.json`
- Create: `apps/oh-my-agent/src/main.ts`

**Actions:**
1. Copy the application script shape from `apps/backend/package.json` and compiler shape from `apps/lark-bot/tsconfig.json`; use package name `@chengchenccc/oh-my-agent` and mark it private.
2. Add only direct runtime dependencies: `@chengchenccc/agent`, `@chengchenccc/agent-backend`, `@chengchenccc/ai`, `@chengchenccc/adapter-mcp`, `@chengchenccc/config`, `elysia`, `zod`, and the already-installed MCP SDK if Phase 2 does not expose a ready MCP client constructor.
3. Add `build`, `dev`, `lint`, `test`, and `typecheck` scripts matching repository conventions; `dev` must execute `src/main.ts`, not Product Backend.
4. Keep `src/main.ts` minimal and compilable: load configuration and exit cleanly until Task 4.4 wires the server; do not export future symbols or add an in-process Runtime fallback.

**Check:**
```bash
bun pm ls --all | grep '@chengchenccc/oh-my-agent'
```
Expected: the new workspace package is listed exactly once.

**Done when:** Bun recognizes `@chengchenccc/oh-my-agent` as an independent workspace application and no source file imports `apps/backend`.

### Task 1.2 — Scaffold the Oma Adapter package

**Time box:** 20 minutes

**Files:**
- Create: `packages/adapter-oma-agent/package.json`
- Create: `packages/adapter-oma-agent/tsconfig.json`
- Create: `packages/adapter-oma-agent/tsconfig.test.json`
- Create: `packages/adapter-oma-agent/src/index.ts`

**Actions:**
1. Copy the package/export/script shape from `packages/adapter-mcp/package.json`.
2. Add runtime dependencies only on `@chengchenccc/agent-backend` and `zod`; use platform `fetch`, `ReadableStream`, and `AbortController` rather than another HTTP/SSE dependency.
3. Export only symbols created in this card. Later cards update the barrel immediately after creating `OmaClient`, `OmaBackend`, and `OmaModelCatalog`.
4. Do not depend on `@chengchenccc/agent`, `@chengchenccc/ai`, Elysia, SQLite, or Product Backend.

**Check:**
```bash
bun pm ls --all | grep -E '@chengchenccc/(oma|adapter-oma-agent)'
```
Expected: both new workspace packages are listed exactly once.

**Done when:** The Adapter package boundary permits only Agent Backend contracts plus transport code.

### Task 1.3 — Define service configuration and trust boundary

**Time box:** 25 minutes

**Files:**
- Create: `apps/oh-my-agent/src/config.ts`
- Create: `apps/oh-my-agent/src/config.test.ts`
- Modify: `apps/oh-my-agent/src/main.ts`

**Actions:**
1. Define and validate dedicated `OMA_*` variables: `HOST`, `PORT`, `AUTH_TOKEN`, `DATA_DIR`, `WORKSPACE_ROOTS`, `MAX_STARTING_WORKERS`, `WORKER_STOP_GRACE_MS`, `ACCEPT_TIMEOUT_MS`, `EVENT_BUFFER_SIZE`, and optional provider variables consumed by Phase 2 `ModelRuntime`. There is deliberately no idle timeout or reap interval: Workers are one-shot and never idle-sleep.
2. Resolve `DATA_DIR/sessions` and workspace allowlisted roots to absolute paths at startup; reject an empty auth token, empty allowlist, non-positive limits, and roots that do not exist.
3. Keep provider credentials inside the Oma process configuration and expose only redacted configured/missing status to later model catalog code.
4. Test defaults, malformed numbers, empty token, and root normalization; do not add the variables to shared Product Backend configuration unless another non-Product process already requires them.

**Check:**
```bash
bun test apps/oh-my-agent/src/config.test.ts
```
Expected: all configuration boundary tests pass; error messages name the invalid `OMA_*` field without printing secret values.

**Done when:** The daemon can fail fast with an isolated single-tenant configuration and no Product Backend credential/provider coupling.

### Task 1.4 — Lock package dependency boundaries

**Time box:** 15 minutes

**Files:**
- Create: `apps/oh-my-agent/src/dependency-boundary.test.ts`
- Create: `packages/adapter-oma-agent/src/dependency-boundary.test.ts`

**Actions:**
1. Read each new package manifest and source imports in a focused test.
2. Assert `apps/oh-my-agent` does not import `apps/backend`, Product DB modules, Conversation History, Agent Context, or old checkpointer/session modules.
3. Assert `packages/adapter-oma-agent` imports neither `@chengchenccc/agent` nor `@chengchenccc/ai`, Elysia, Drizzle, `bun:sqlite`, or `apps/*`.
4. Assert no file contains an in-process fallback factory or conditional Runtime import path.

**Check:**
```bash
bun test apps/oh-my-agent/src/dependency-boundary.test.ts packages/adapter-oma-agent/src/dependency-boundary.test.ts
```
Expected: both package-boundary tests pass.

**Done when:** The independent process and Adapter-only boundaries are executable constraints rather than review comments.

---

## Wave 2 — Freeze HTTP, SSE, and Worker IPC contracts before process code

### Task 2.1 — Define transport DTOs and route contract

**Time box:** 30 minutes

**Files:**
- Create: `packages/adapter-oma-agent/src/transport.ts`
- Create: `packages/adapter-oma-agent/src/transport.test.ts`

**Actions:**
1. Define Zod wire schemas and inferred types for `StartSessionRequest/Response`, `SendRunRequest/Response`, `ResumeSessionRequest/Response`, `StopSessionResponse`, `CloseSessionResponse`, `CompactSessionRequest/Response`, `RunEventEnvelope`, `RunOutcomeResponse`, `ModelCatalogResponse`, and structured transport errors.
2. Freeze routes: `GET /health`, `GET /v1/models`, `POST /v1/sessions/start`, `POST /v1/sessions/:backendSessionId/send`, `POST /v1/sessions/:backendSessionId/resume`, `POST /v1/sessions/:backendSessionId/stop`, `POST /v1/sessions/:backendSessionId/compact`, `DELETE /v1/sessions/:backendSessionId`, `GET /v1/runs/:runId/events`, and `GET /v1/runs/:runId/outcome`.
3. Require `idempotencyKey` on every mutation and preserve `runId`, `branchId`, `productEntryId`, `backendSessionId`, `commandId`, and `eventId` as distinct fields.
4. Make `send.mode` exactly `normal | steer | follow_up`; do not define a steer route or a respond route.
5. Test schema rejection of missing snapshots, missing `productEntryId`, unknown modes, and malformed identities.

**Check:**
```bash
bun test packages/adapter-oma-agent/src/transport.test.ts
```
Expected: DTO round-trip tests pass and malformed identity/mode cases fail schema parsing.

**Done when:** Service and Adapter can share one wire contract without importing one another’s implementation.

### Task 2.2 — Define the NDJSON Worker protocol

**Time box:** 30 minutes

**Files:**
- Create: `apps/oh-my-agent/src/worker-protocol.ts`
- Create: `apps/oh-my-agent/src/worker-protocol.test.ts`

**Actions:**
1. Define daemon-to-Worker commands `open_session`, `start_run`, `send`, `compact`, `stop_run`, `close_session`, and `shutdown`; every command carries `protocolVersion`, `commandId`, `backendSessionId`, and the applicable `runId`.
2. Define Worker-to-daemon messages `ready`, `command_accepted`, `event`, `outcome`, `command_error`, and `fatal`; every event/outcome carries session, run, command, and event identity.
3. Encode one JSON object per line with a maximum line size and strict Zod parsing; reject unknown protocol versions and unknown discriminants.
4. Preserve `ProjectedHistoryItem.productEntryId` without renaming or regeneration in all start/send payloads.
5. Test split chunks, multiple lines in one chunk, oversized lines, malformed JSON, identity mismatch, and valid round trips.

**Check:**
```bash
bun test apps/oh-my-agent/src/worker-protocol.test.ts
```
Expected: parser tests pass; malformed/oversized/version-mismatched input is rejected before Runtime dispatch.

**Done when:** Worker IPC is explicit, versioned, bounded, and identity-safe.

### Task 2.3 — Implement bounded monotonic run event replay

**Time box:** 25 minutes

**Files:**
- Create: `apps/oh-my-agent/src/event-buffer.ts`
- Create: `apps/oh-my-agent/src/event-buffer.test.ts`

**Actions:**
1. Implement a per-`runId` ring buffer bounded by `EVENT_BUFFER_SIZE`; allocate strictly increasing decimal event IDs per run.
2. Support append, subscribe-after, terminal close, subscriber cancellation, and lookup of the oldest retained ID.
3. Make a stale `Last-Event-ID` fail with a typed `replay_window_exceeded` result instead of silently skipping events.
4. Keep run outcome separately from the SSE subscriber so disconnect/abort never cancels execution or erases the outcome.
5. Test ordering, eviction, concurrent subscribers, reconnect replay, stale replay, and disconnect independence.

**Check:**
```bash
bun test apps/oh-my-agent/src/event-buffer.test.ts
```
Expected: all replay/eviction/disconnect tests pass with monotonic IDs.

**Done when:** SSE is a bounded observation channel, not the recovery source or run owner.

### Task 2.4 — Define session records and legal lifecycle transitions

**Time box:** 25 minutes

**Files:**
- Create: `apps/oh-my-agent/src/session-record.ts`
- Create: `apps/oh-my-agent/src/session-record.test.ts`

**Actions:**
1. Define daemon-local states `idle`, `starting`, `running`, `closing`, `closed`, and `crashed`, plus `activeRunId`, Worker PID, last activity, and settled run outcomes. There is no `sleeping` state: a session is `idle` whenever no Worker is live.
2. Permit one Worker and at most one active Agent Run per `backendSessionId`; the Worker lives only while its Run executes. Reject concurrent normal/follow-up starts while allowing `send(mode: "steer")` only against the active run.
3. Make worker crash transition the active run to failed and the session to `crashed`; never mark the active loop resumable. A settled run's Worker exiting returns the session to `idle`.
4. Do not store Product Tool manifests or run identity on the record: Product Tools come only from the current `AgentRunSnapshot`, and run identity (conversation/agentMember) is the session's, carried into `open_session`.
5. Define close as stop (when a run is live) plus SessionStore deletion; define compact as a one-shot maintenance Worker, not a long-lived path.
6. Test every legal transition and rejection of illegal/concurrent transitions.

**Check:**
```bash
bun test apps/oh-my-agent/src/session-record.test.ts
```
Expected: lifecycle matrix tests pass; a crashed record cannot return to `running` through resume.

**Done when:** Session lifecycle semantics are fixed before the supervisor introduces process races.

---

## Wave 3 — Build the Worker and process supervisor

### Task 3.1 — Construct one Runtime inside one Worker

**Time box:** 30 minutes

**Files:**
- Create: `apps/oh-my-agent/src/worker-main.ts`
- Create: `apps/oh-my-agent/src/worker-runtime.ts`
- Create: `apps/oh-my-agent/src/worker-runtime.test.ts`

**Actions:**
1. Read NDJSON commands from stdin with the Task 2 parser and emit protocol messages only on stdout; send logs to stderr with session/run prefixes and secret redaction.
2. On `open_session`, construct Phase 2 `SqliteSessionStore`, `ModelRuntime`, native tools, static plugins, skill roots, web ports, and MCP tool transport for exactly one session file; retain the session's conversation/agentMember identity from the command.
3. On `start_run`/normal or follow-up `send`, atomically submit projected history + one Meta + one Prompt; on steer append only a steer input at the Runtime safe boundary.
4. Forward typed Runtime lifecycle events and exactly one terminal outcome; await Runtime listeners before emitting outcome.
5. **One-shot:** after the run's outcome (or compact's `command_result`) close the Runtime (MCP clients, store), close stdin, and exit. A second `start_run` or normal/follow-up `send` is a protocol violation: emit `fatal` and exit non-zero. Treat malformed daemon input, session identity mismatch, and uncaught Runtime errors as `fatal` then exit non-zero; never create a second session in the same Worker.

**Check:**
```bash
bun test apps/oh-my-agent/src/worker-runtime.test.ts
```
Expected: the in-memory harness proves normal/follow-up/steer dispatch and exactly-one outcome without spawning the daemon.

**Done when:** A Worker owns one complete Oma Runtime and has no Product Backend imports or database access.

### Task 3.2 — Implement Worker process handles and strict IPC isolation

**Time box:** 30 minutes

**Files:**
- Create: `apps/oh-my-agent/src/worker-process.ts`
- Create: `apps/oh-my-agent/src/worker-process.test.ts`

**Actions:**
1. Spawn `bun run apps/oh-my-agent/src/worker-main.ts` with piped stdin/stdout/stderr and only the session/model/tool environment required by that Worker.
2. Correlate commands through `commandId`; reject duplicate in-flight IDs and responses whose session/run/command identity does not match.
3. Parse stdout exclusively as protocol NDJSON; forward stderr as redacted diagnostics without parsing it as business events.
4. Implement graceful termination as `shutdown` → wait `WORKER_STOP_GRACE_MS` → `SIGTERM` → bounded wait → `SIGKILL`, following `apps/backend/src/features/lark-bot/registry.ts`.
5. Test acceptance, timeout, exit, malformed stdout, identity mismatch, and kill escalation with a fixture Worker.

**Check:**
```bash
bun test apps/oh-my-agent/src/worker-process.test.ts
```
Expected: process tests pass; malformed stdout kills only the fixture Worker and produces one typed fatal result.

**Done when:** The daemon never trusts unvalidated Worker output and can terminate a stuck process predictably.

### Task 3.3 — Implement CodingSessionSupervisor start/open/send/stop/close

**Time box:** 30 minutes

**Files:**
- Create: `apps/oh-my-agent/src/session-supervisor.ts`
- Create: `apps/oh-my-agent/src/session-supervisor.test.ts`

**Actions:**
1. Maintain a map keyed by `backendSessionId`; serialize lifecycle mutations per session with a Promise chain and dedupe concurrent identical idempotency keys into one in-flight Promise (no double Worker spawn).
2. Implement create/start, resume/open, normal/follow-up send, active-run steer, stop, compact, and close by dispatching Worker commands. Every run path: reserve the run (`activeRunId` + event buffer) BEFORE the Worker exists, spawn the one-shot Worker, hand it the command, and return on `command_accepted`. The Worker executes and exits on its own.
3. Store mutation results by `idempotencyKey`; an exact replay returns the original session/run response, while key reuse with a different payload returns conflict. A `runId` already owned by any session's buffer/outcome is a global collision, rejected.
4. Route Worker events/outcomes to the per-run event buffer; a Worker exit fails only that Worker's active run (first-write-wins failed outcome, buffer closed, session `crashed`) and leaves other records untouched. A Worker exit after its run settled returns the session to `idle`.
5. steer/stop are control paths to the current run's Worker (no new run, no new Worker); compact is a one-shot maintenance Worker whose completion is `command_result`; close stops the active run with a bounded outcome window, then a bounded Worker exit with SIGTERM/SIGKILL escalation, then deletes the SessionStore.
6. Test two-session isolation, one-run-one-Worker PID rotation, active-run exclusion, mutation replay, key conflict, stop idempotency, and close idempotency.

**Check:**
```bash
bun test apps/oh-my-agent/src/session-supervisor.test.ts
```
Expected: supervisor tests pass, including two distinct Worker PIDs per Run and one-crash/other-continues isolation.

**Done when:** Every active Run has exactly one Worker, the session returns to `idle` after that Worker exits, and command acceptance is idempotent.

### Task 3.4 — Enforce one Worker per Run with startup limiting

**Time box:** 25 minutes

**Files:**
- Modify: `apps/oh-my-agent/src/session-supervisor.ts`
- Modify: `apps/oh-my-agent/src/session-supervisor.test.ts`

**Actions:**
1. Add a small FIFO semaphore around Worker starts using `MAX_STARTING_WORKERS`; do not limit already-running Workers with this semaphore.
2. Do NOT implement an idle reaper, sleep state, or wake path: a Worker lives only while its Run executes and exits after its outcome. The next Run spawns a fresh PID over the same SQLite session.
3. Enforce that a Worker receiving a second normal Run (start_run or normal/follow-up send) fails fatally; the Supervisor never sends one.
4. Test bounded concurrent starts, at most one active Run per session, distinct PIDs for consecutive Runs on the same session, and session state restoration after a Worker exits (branch/todo/compaction preserved via the SQLite store).

**Check:**
```bash
bun test apps/oh-my-agent/src/session-supervisor.test.ts --test-name-pattern='startup|one-shot|PID'
```
Expected: focused tests pass; consecutive Runs on one session use different Worker PIDs and the second Worker reads the state the first persisted.

**Done when:** Resource control is bounded without a resident-Worker lifecycle.

### Task 3.5 — Make crash semantics explicit and non-recovering

**Time box:** 25 minutes

**Files:**
- Modify: `apps/oh-my-agent/src/session-supervisor.ts`
- Create: `apps/oh-my-agent/src/crash-isolation.test.ts`

**Actions:**
1. On unexpected Worker exit (its run has not settled), resolve the active run outcome as `failed` with a stable worker-crash code, close the run's event buffer, and mark the session `crashed`.
2. Reject resume of that active loop and reject any attempt to reconstruct it from partial Worker/session data.
3. Permit a later new Coding Session to be started from fresh projected Agent Context; do not silently reuse the crashed session as canonical history.
4. Keep sibling Workers, their event streams, and their outcomes running.
5. Cover non-zero exit, signal exit, malformed IPC, and crash during synchronous Product Tool wait. Use ONE supervisor whose fixture Worker decides per sessionId/runId whether to crash or complete - not two independent daemons.

**Check:**
```bash
bun test apps/oh-my-agent/src/crash-isolation.test.ts
```
Expected: each crash case fails only its run; the sibling fixture run completes; no active-loop recovery command is sent.

**Done when:** Worker fault isolation and “current Agent Run fails” are proven end to end.

---

## Wave 4 — Expose the authenticated daemon API and replayable SSE

### Task 4.1 — Add constant-time service authentication

**Time box:** 20 minutes

**Files:**
- Create: `apps/oh-my-agent/src/auth.ts`
- Create: `apps/oh-my-agent/src/auth.test.ts`

**Actions:**
1. Implement `x-auth-token` verification with equal-length guarding followed by `crypto.timingSafeEqual`, matching `apps/backend/src/infra/auth.ts` without importing Product Backend.
2. Allow unauthenticated `GET /health` only; require auth for models, commands, outcomes, and SSE.
3. Return the same `401` body for missing, short, long, and incorrect tokens.
4. Test valid and invalid cases without logging either candidate or configured token.

**Check:**
```bash
bun test apps/oh-my-agent/src/auth.test.ts
```
Expected: all auth cases pass and unauthorized response bodies are indistinguishable.

**Done when:** The daemon has one explicit service credential boundary.

### Task 4.2 — Implement route handlers and validation

**Time box:** 30 minutes

**Files:**
- Create: `apps/oh-my-agent/src/routes.ts`
- Create: `apps/oh-my-agent/src/routes.test.ts`

**Actions:**
1. Implement the Task 2 route set with Elysia and shared wire schemas; validate path IDs and bodies before supervisor calls.
2. Map accepted/idempotent/conflict/not-found/busy/replay-window errors to stable HTTP statuses and structured error codes.
3. Return mutation acceptance only after Worker `command_accepted`; never report delivery before acceptance.
4. Keep `POST /compact` as a Oma transport operation but outside `AgentBackend`; do not expose `respond` or a separate steer endpoint.
5. Test every route, auth requirement, status mapping, and absence of forbidden endpoints.

**Check:**
```bash
bun test apps/oh-my-agent/src/routes.test.ts
```
Expected: route contract tests pass; `/respond` and `/steer` return 404.

**Done when:** HTTP semantics match the frozen transport and no Product caller is mounted.

### Task 4.3 — Implement SSE replay and independent outcome retrieval

**Time box:** 30 minutes

**Files:**
- Modify: `apps/oh-my-agent/src/routes.ts`
- Modify: `apps/oh-my-agent/src/routes.test.ts`

**Actions:**
1. Implement `GET /v1/runs/:runId/events` as `text/event-stream` with `id`, `event`, JSON `data`, heartbeat comments, and request-abort cleanup, following `apps/backend/src/http/response.ts`.
2. Parse `Last-Event-ID` and replay strictly after it; return `409 replay_window_exceeded` if the requested ID predates retained events.
3. Keep Worker execution alive when an SSE request disconnects and expose terminal truth through `GET /v1/runs/:runId/outcome`.
4. Ensure terminal outcomes are immutable and repeatable; return `202 running` until settled and `200` afterward.
5. Test initial stream, reconnect, disconnect, stale replay, heartbeat, and repeated outcome fetch.

**Check:**
```bash
bun test apps/oh-my-agent/src/routes.test.ts --test-name-pattern='SSE|Last-Event-ID|outcome|disconnect'
```
Expected: focused tests pass; disconnecting the first stream does not abort the fixture run.

**Done when:** Events are replayable within the buffer and outcomes do not depend on stream lifetime.

### Task 4.4 — Compose app, server, startup, and graceful shutdown

**Time box:** 25 minutes

**Files:**
- Create: `apps/oh-my-agent/src/app.ts`
- Create: `apps/oh-my-agent/src/server.ts`
- Modify: `apps/oh-my-agent/src/main.ts`
- Create: `apps/oh-my-agent/src/main.test.ts`

**Actions:**
1. Compose config, model runtime/catalog, event store, supervisor, routes, and auth in `createOmaApp`; keep constructors injectable for tests.
2. Start `Bun.serve` with `idleTimeout: 0` for SSE, mirroring `apps/backend/src/server.ts`.
3. On SIGTERM/SIGINT, stop accepting HTTP, stop active runs, gracefully terminate all Workers, close session stores, then exit.
4. Make shutdown idempotent and bounded; force-kill only Workers exceeding grace.
5. Test health, startup failure, double shutdown, and Worker cleanup with injected process handles.

**Check:**
```bash
bun test apps/oh-my-agent/src/main.test.ts
```
Expected: app lifecycle tests pass; every fixture Worker receives graceful shutdown exactly once.

**Done when:** The daemon starts independently, answers health checks, and shuts down without orphan Workers.

---

## Wave 5 — Publish models and implement the Agent Backend Adapter

### Task 5.1 — Publish a redacted Backend Model catalog

**Time box:** 25 minutes

**Files:**
- Create: `apps/oh-my-agent/src/model-catalog.ts`
- Create: `apps/oh-my-agent/src/model-catalog.test.ts`
- Modify: `apps/oh-my-agent/src/routes.ts`

**Actions:**
1. Map Phase 2 `ModelRuntime` models to `BackendModel` with canonical `provider/model` IDs, display name, reasoning support, modalities, context window, max output tokens, and availability.
2. Filter availability through the daemon CredentialStore but expose only configured/missing/refresh-failed state; never expose API keys, headers, base auth, or Provider objects.
3. Reject model IDs whose provider/model pair is unknown when starting/sending a run.
4. Serve the mapping through authenticated `GET /v1/models`.
5. Test mapping, unavailable credentials, refresh failure, unknown model rejection, and secret absence in serialized output.

**Check:**
```bash
bun test apps/oh-my-agent/src/model-catalog.test.ts
```
Expected: catalog tests pass and serialized fixtures contain no credential value.

**Done when:** Product code can discover models without depending on Runtime provider types.

### Task 5.2 — Implement the HTTP/SSE transport client

**Time box:** 30 minutes

**Files:**
- Create: `packages/adapter-oma-agent/src/client.ts`
- Create: `packages/adapter-oma-agent/src/client.test.ts`

**Actions:**
1. Implement authenticated JSON requests with shared schema parsing, caller `AbortSignal`, stable error mapping, and no automatic mutation retry beyond explicit idempotency replay by the caller.
2. Implement `startSession`, `sendRun`, `resumeSession`, `stopSession`, `closeSession`, `compactSession`, `getOutcome`, and `streamEvents(lastEventId?)`.
3. Parse SSE incrementally across arbitrary chunks; expose event IDs for reconnect and ignore heartbeat comments.
4. Reconnect only when the consumer continues iteration, passing the last delivered ID; surface `replay_window_exceeded` without inventing missing events.
5. Test auth header, abort, malformed JSON, malformed SSE, reconnect ID, HTTP errors, and immutable outcome polling.

**Check:**
```bash
bun test packages/adapter-oma-agent/src/client.test.ts
```
Expected: client transport tests pass using an in-process fake HTTP server only; no Oma Runtime import is present.

**Done when:** The Adapter has one reusable transport client and no direct daemon internals.

### Task 5.3 — Map Oma events and outcomes

**Time box:** 25 minutes

**Files:**
- Create: `packages/adapter-oma-agent/src/event-mapper.ts`
- Create: `packages/adapter-oma-agent/src/event-mapper.test.ts`

**Actions:**
1. Map text, thinking, native tool, Product Tool, status, turn completion, and turn failure events to Phase 0 `BackendEvent` core kinds.
2. Map Runtime-only lifecycle details under `backend.oma.*`; never create an unnamespaced extension.
3. Map terminal outcomes exactly to `completed | failed | aborted | timeout`; reject `suspended` from this backend because `pendingActionResponse=false`.
4. Preserve usage and final `Message` without inferring completion from stream closure or final text.
5. Test every supported mapping, unknown extension mapping, malformed payload rejection, and suspended-outcome rejection.

**Check:**
```bash
bun test packages/adapter-oma-agent/src/event-mapper.test.ts
```
Expected: mapping tests pass and all extension names begin `backend.oma.`.

**Done when:** Product-facing events/outcomes are stable and Runtime-specific details remain namespaced.

### Task 5.4 — Implement `OmaBackend` with the exact method set

**Time box:** 30 minutes

**Files:**
- Create: `packages/adapter-oma-agent/src/backend.ts`
- Create: `packages/adapter-oma-agent/src/backend.test.ts`
- Modify: `packages/adapter-oma-agent/src/index.ts`

**Actions:**
1. Implement `AgentBackend` properties `kind="oma"` and capabilities `persistentSession=true`, `nativeResume=true`, `nativeSteer=true`, `productTools="mcp"`, `pendingActionResponse=false`, with truthful `thinkingStream` from the Runtime transport contract.
2. Implement only the interface methods `start`, `send`, `resume`, `respond`, `stop`, and `close`; `start`/`resume` return session handle plus first run segment.
3. Route steer exclusively through `send(session, { ...input, mode: "steer" })`; do not add `steer()` to the class or transport client.
4. Implement `respond()` as an immediate typed unsupported error without any HTTP request, pending state, or endpoint.
5. Build each segment from SSE events plus the independent outcome endpoint; make `segment.stop()` delegate to the same stop mutation.

**Check:**
```bash
bun test packages/adapter-oma-agent/src/backend.test.ts
```
Expected: interface tests pass; method keys are exactly `start/send/resume/respond/stop/close`; steer uses `/send`; respond performs zero fetches.

**Done when:** The Oma is a complete Agent Backend implementation without pretending to support durable pending actions.

### Task 5.5 — Implement the separate model catalog Adapter

**Time box:** 20 minutes

**Files:**
- Create: `packages/adapter-oma-agent/src/model-catalog.ts`
- Create: `packages/adapter-oma-agent/src/model-catalog.test.ts`
- Modify: `packages/adapter-oma-agent/src/index.ts`

**Actions:**
1. Implement `OmaModelCatalog` as a thin adapter over `OmaClient.getModels()`.
2. Return Phase 0 `BackendModelCatalog`/`BackendModel` values without leaking transport or Provider fields.
3. Keep model catalog outside the `AgentBackend` method set.
4. Test successful mapping, unavailable models, schema rejection, and auth errors.

**Check:**
```bash
bun test packages/adapter-oma-agent/src/model-catalog.test.ts
```
Expected: catalog Adapter tests pass and `OmaBackend` has no model-listing method.

**Done when:** Runtime model discovery is independently composable in Phase 4.

---

## Wave 6 — Prove Product Tool transport and full process behavior

### Task 6.1 — Define Worker-side Product Tool MCP identity

**Time box:** 25 minutes

**Files:**
- Create: `apps/oh-my-agent/src/product-tool-transport.ts`
- Create: `apps/oh-my-agent/src/product-tool-transport.test.ts`

**Actions:**
1. Implement a dedicated Product Tool MCP wrapper in this file; do not reuse `adaptMcpTool`, whose current caller interface drops `AbortSignal`.
2. Bind every call to immutable `runId`, `conversationId`, `agentMemberId`, `branchId`, the REAL model tool-use ID (`PendingToolCall.id`), and idempotency key `${runId}:${toolUseId}` through request metadata. If `Tool.execute()` cannot receive the tool-use ID today, make the minimal internal execution-context change to pass it; do not build a generic framework.
3. Define a cancellable caller interface such as `callTool(params, { signal, timeoutMs })`; wire stop/Worker shutdown to `AbortSignal` when the MCP SDK transport supports it, otherwise close the dedicated transport and normalize cancellation deterministically.
4. Await the MCP response synchronously and return timeout, cancellation, authorization, and Product Tool failures as tool results, not provider retry.
5. Test identity propagation, timeout, cancellation/transport close, and error normalization with a fake caller; the recorded callId must be the model tool-use ID, never an event-id or order counter.

**Check:**
```bash
bun test apps/oh-my-agent/src/product-tool-transport.test.ts
```
Expected: focused tests pass; every recorded call includes all six identity fields and the original input.

**Done when:** Worker Product Tool calls are synchronous, attributable, cancellable, and transport-only.

### Task 6.2 — Build the Product Tool contract-test MCP server

**Time box:** 30 minutes

**Files:**
- Create: `apps/oh-my-agent/src/fixtures/product-tool-contract-server.ts`
- Create: `apps/oh-my-agent/src/product-tool-contract.test.ts`

**Actions:**
1. Start a real test MCP server using the installed SDK and register deterministic tools `echo_identity`, `wait_until_released`, `timeout`, and `fail`.
2. Record and assert run/member/conversation/branch/call/idempotency identity before returning tool output.
3. Drive the server from a real spawned Worker through the same Product Tool transport used in production.
4. Verify synchronous wait completes after release, timeout returns a tool error, and abort cancels the in-flight request on stop/Worker exit.
5. Ensure the server is test-only and does not become a Product Backend implementation or daemon fallback.

**Check:**
```bash
bun test apps/oh-my-agent/src/product-tool-contract.test.ts
```
Expected: real Worker-to-MCP contract tests pass for success, identity, synchronous wait, timeout, cancellation, and failure.

**Done when:** Phase 4 can implement Product Tools behind this proven transport contract without changing the Worker.

### Task 6.3 — Prove session persistence and `productEntryId` fidelity

**Time box:** 30 minutes

**Files:**
- Create: `apps/oh-my-agent/src/session-lifecycle.integration.test.ts`

**Actions:**
1. Start a daemon fixture with a temporary data directory and deterministic fake model provider; create a session with projected history containing known `productEntryId` values.
2. Complete Run 1, assert its one-shot Worker exited (session `idle`), then send Run 2 and record the new Worker PID - it must differ from Run 1's.
3. Open the per-session SQLite store through the Phase 2 read API and assert original `productEntryId` values are unchanged and not duplicated across the two Workers.
4. Assert completed branch, todo, and compaction state survive the Worker replacement while the system prompt remains outside the Coding Session Tree.
5. Replay the original mutation idempotency key and assert no new Worker/run/input batch is created.

**Check:**
```bash
bun test apps/oh-my-agent/src/session-lifecycle.integration.test.ts
```
Expected: integration test passes with different pre/post Worker PIDs, one copy of each Product entry, and one semantic run for the replayed mutation.

**Done when:** Persistent session behavior and Product history identity survive real Worker replacement.

### Task 6.4 — Prove Adapter-to-daemon Agent Run end to end

**Time box:** 30 minutes

**Files:**
- Create: `packages/adapter-oma-agent/src/backend.integration.test.ts`

**Actions:**
1. Start the real Oma app on an ephemeral port with a temporary session root, fake provider, and contract-test MCP server.
2. Construct only `OmaClient`, `OmaBackend`, and Phase 0 inputs; call `start()` and consume mapped events plus outcome.
3. Send a steer input through `send(mode: "steer")`, complete a Product Tool call, and assert one terminal completed outcome with final `Message` and usage.
4. Disconnect/reconnect SSE using the last event ID and verify no duplicate mapped events.
5. Stop and close the session through the Agent Backend methods and assert the Worker exits and session file is deleted.

**Check:**
```bash
bun test packages/adapter-oma-agent/src/backend.integration.test.ts
```
Expected: a real independent Worker completes the Agent Run through Adapter HTTP/SSE; no Product Backend process or in-process Runtime path is used.

**Done when:** Phase 3’s completion condition is satisfied without Phase 4 composition.

---

## Wave 7 — Destructive Phase 3 gate

### Task 7.1 — Run the complete focused Phase 3 verification matrix

**Time box:** 30 minutes

**Files:**
- Verify only; change a file only to fix a failing Phase 3 requirement.

**Actions:**
1. Run package tests/typechecks/builds for the two new workspace units.
2. Run the daemon smoke scenario with two sessions, one Worker per Run (distinct PIDs), one forced crash, idempotent replay, and SSE reconnect.
3. Run the Product Tool MCP contract and full Adapter integration tests.
4. Search for forbidden fallback/respond/legacy surfaces and dependency leaks.
5. Record exact command output in the implementation handoff; do not waive a gate because Phase 4 is not implemented.

**Check:**
```bash
bun run --cwd apps/oh-my-agent build && \
bun run --cwd apps/oh-my-agent typecheck && \
bun test apps/oh-my-agent/src && \
bun run --cwd packages/adapter-oma-agent build && \
bun run --cwd packages/adapter-oma-agent typecheck && \
bun test packages/adapter-oma-agent/src
```
Expected: all six commands exit 0.

Then run the exact smoke matrix:

```bash
bun test \
  apps/oh-my-agent/src/session-supervisor.test.ts \
  apps/oh-my-agent/src/integration/session-lifecycle.integration.test.ts \
  apps/oh-my-agent/src/integration/backend.integration.test.ts \
  apps/oh-my-agent/src/product-tool-contract.test.ts
```
Expected: all tests pass and output demonstrates:
- each Run uses its own Worker process and a different PID from the previous Run on the same session;
- every Worker exits after its outcome;
- a Worker exiting without settling its run fails that run and never hangs;
- a settled run's Worker exit returns the session to idle, and the next Run restores completed session state from SQLite;
- active-loop crash is failed, not resumed;
- replaying a mutation key does not start another Worker/run;
- concurrent identical mutations spawn only one Worker;
- SSE reconnect after `Last-Event-ID` emits only later events;
- disconnecting SSE does not change the terminal outcome;
- malformed IPC terminates only its Worker;
- a Worker synchronously calls the contract-test Product Tool with identity, timeout, and cancellation behavior.

Run forbidden-surface checks:

```bash
! grep -R "respond" apps/oh-my-agent/src/routes.ts apps/oh-my-agent/src/app.ts
! grep -R "steer(" packages/adapter-oma-agent/src
! grep -R --exclude='*.test.ts' -E "checkpointer|runtimeSessionId|pendingContinuation|createAgent\(" apps/oh-my-agent/src packages/adapter-oma-agent/src
! grep -R -E "from .*(@chengchenccc/(agent|ai)|apps/backend|elysia|drizzle|bun:sqlite)" packages/adapter-oma-agent/src
```
Expected: all negated searches exit 0. The exact `respond()` method remains only in `packages/adapter-oma-agent/src/backend.ts` and its test as an unsupported interface implementation; there is no respond transport route.

**Done when:** Every Phase 3 acceptance item has passing executable evidence.

### Task 7.2 — Mark the destructive checkpoint and hand off to Phase 4

**Time box:** 15 minutes

**Files:**
- Verify: `docs/superpowers/specs/agent-backend-oma-rewrite/phase-3-oma-service.md`
- Verify: `docs/superpowers/specs/agent-backend-oma-rewrite/README.md`

**Actions:**
1. Confirm Product Backend callers are unchanged and no Agent Run execution registry/composition was added early.
2. Confirm `AgentBackend` surface is exactly `start/send/resume/respond/stop/close`, steer is `send(mode: "steer")`, and model catalog is separate.
3. Confirm no compatibility shim, old session/checkpoint migration, in-process fallback, dual write, or old/new transport remains.
4. Confirm provider credentials remain daemon-only and the daemon never accesses Product DB, Conversation History, Agent Context, or Ledger.
5. Hand Phase 4 the stable Adapter constructor, model catalog constructor, Product Tool MCP identity contract, service URL/token configuration, and verified smoke commands.

**Check:**
```bash
bun test packages/adapter-oma-agent/src/backend.test.ts --test-name-pattern='method set|capabilities|respond|steer' && \
bun test apps/oh-my-agent/src/dependency-boundary.test.ts packages/adapter-oma-agent/src/dependency-boundary.test.ts
```
Expected: focused contract and boundary gates pass.

**Done when:** **DESTRUCTIVE CHECKPOINT — PHASE 3 COMPLETE:** Oma is independently deployable and usable through the Adapter contract; Product caller cutover has not begun, and Phase 4 can connect Agent Run execution without reopening Worker, transport, replay, auth, model catalog, or Product Tool protocol design.
