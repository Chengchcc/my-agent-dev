# Storage Convergence — Detailed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Converge 3 databases into 2 (events.db → backend.db), delete dead tables (projection_messages, runner_health), narrow dead enum (RunOpsEventKind 15→3), rename run_ops_event→control_plane_event, and fix 4 functional bugs from 33d1e392.

**Architecture:** Two PRs. PR-1 fixes user-facing bugs (B0 readonly WAL crash, B1 todo loss, B2 frontend id mismatch). PR-2 does storage convergence (delete dead tables, narrow enum, rename table, merge events.db into backend.db) in a single drizzle-kit generate.

**Tech Stack:** TypeScript (strict), bun:sqlite, drizzle-orm, React/Next.js, bun:test

---

## Pre-Flight Verification

Before any code changes, verify the baseline:

- [ ] **Step 0.1: Verify HEAD is 33d1e392**

```bash
git rev-parse HEAD
```
Expected: `33d1e392...`

- [ ] **Step 0.2: Run full test suite to confirm clean baseline**

```bash
cd /root/my-agent-team && bun run test
```
Expected: all tests pass, zero failures.

- [ ] **Step 0.3: Run typecheck to confirm clean baseline**

```bash
cd /root/my-agent-team && bun run typecheck
```
Expected: zero type errors.

- [ ] **Step 0.4: Create feature branch for PR-1**

```bash
git checkout -b fix/storage-bugs-b0-b1-b2
```

---

## PR-1: Fix B0, B1, B2 (Functional Bugs)

### Task 1: B0 — Remove WAL PRAGMA from Readonly Checkpoint Connection

**Files:**
- Modify: `apps/backend/src/features/runtime-ops/checkpoint-events-store.ts:17`
- Create: `apps/backend/src/features/runtime-ops/checkpoint-events-store.test.ts`

- [ ] **Step 1.1: Write the failing test**

Create `apps/backend/src/features/runtime-ops/checkpoint-events-store.test.ts`:

```typescript
import { describe, expect, it, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createCheckpointEventsStore } from "./checkpoint-events-store.js";

function tmpDir() {
  return mkdtempSync("/tmp/checkpoint-events-store-test-");
}

describe("createCheckpointEventsStore", () => {
  it("does not throw when opened on a readonly connection to a WAL database", () => {
    const dir = tmpDir();
    const dbPath = join(dir, "test.db");
    try {
      // Simulate what the framework checkpointer does: write-side setup
      const writer = new Database(dbPath);
      writer.exec("PRAGMA journal_mode=WAL");
      writer.exec(
        "CREATE TABLE IF NOT EXISTS checkpoint_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, span_id TEXT NOT NULL, ts INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}')"
      );
      writer.close();

      // Now open readonly — exactly what main.ts:216 does
      const reader = new Database(dbPath, { readonly: true });

      // This must not throw SQLITE_READONLY
      expect(() => createCheckpointEventsStore(reader)).not.toThrow();

      // And basic queries should work
      const store = createCheckpointEventsStore(reader);
      expect(() => store.readBySpan("s1", "sp1")).not.toThrow();

      reader.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readBySpan returns empty array for no matching events", () => {
    const dir = tmpDir();
    const dbPath = join(dir, "test.db");
    try {
      const writer = new Database(dbPath);
      writer.exec("PRAGMA journal_mode=WAL");
      writer.exec(
        "CREATE TABLE IF NOT EXISTS checkpoint_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, span_id TEXT NOT NULL, ts INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}')"
      );
      writer.close();

      const reader = new Database(dbPath, { readonly: true });
      const store = createCheckpointEventsStore(reader);
      const events = store.readBySpan("nonexistent", "nonexistent");
      expect(events).toEqual([]);
      reader.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 1.2: Run the test to confirm it fails**

```bash
cd /root/my@chengchenccc/apps/backend && bun test --test-name-pattern="createCheckpointEventsStore"
```
Expected: Test FAILS with `SQLITE_READONLY` error from `db.exec("PRAGMA journal_mode=WAL")` on line 17 of `checkpoint-events-store.ts`.

- [ ] **Step 1.3: Apply the fix — delete the WAL PRAGMA line**

In `apps/backend/src/features/runtime-ops/checkpoint-events-store.ts`, delete line 17:

```typescript
// BEFORE (lines 15-19):
export function createCheckpointEventsStore(db: Database): CheckpointEventsStore {
  db.exec("PRAGMA journal_mode=WAL");   // ← DELETE THIS LINE
  function parseRows(rows: unknown[]): CheckpointEventRow[] {

// AFTER:
export function createCheckpointEventsStore(db: Database): CheckpointEventsStore {
  // WAL mode is set and persisted by the framework checkpointer (the writer).
  // This store opens the DB readonly — executing write PRAGMAs would throw SQLITE_READONLY.
  function parseRows(rows: unknown[]): CheckpointEventRow[] {
```

- [ ] **Step 1.4: Run the test to confirm it passes**

```bash
cd /root/my@chengchenccc/apps/backend && bun test --test-name-pattern="createCheckpointEventsStore"
```
Expected: All tests PASS.

- [ ] **Step 1.5: Verify no other tests broke**

```bash
cd /root/my@chengchenccc/apps/backend && bun test
```
Expected: All tests pass.

- [ ] **Step 1.6: Commit**

```bash
git add apps/backend/src/features/runtime-ops/checkpoint-events-store.ts \
        apps/backend/src/features/runtime-ops/checkpoint-events-store.test.ts
git commit -m "fix(B0): remove WAL PRAGMA from readonly checkpoint connection

The createCheckpointEventsStore was executing PRAGMA journal_mode=WAL on a
readonly connection (opened at main.ts:216). WAL is already set by the framework
checkpointer (the writer) and persisted in the DB file. Executing it on a readonly
connection throws SQLITE_READONLY, causing all Ops detail/Insights pages to 500."
```

---

### Task 2: B1 — Connect todo_update to Accumulator

**Files:**
- Modify: `apps/backend/src/main.ts` (add todo_update branch in onRunMessage callback)
- Modify: `apps/backend/src/features/conversation/projection.test.ts` (add todo tests)
- Reference: `apps/backend/src/features/conversation/projection.ts:30,50,218-220` (accumulator)

- [ ] **Step 2.1: Verify the current state — confirm lastTodoUpdate has zero write sites**

```bash
cd /root/my-agent-team && grep -rn "lastTodoUpdate\s*=" --include="*.ts" --include="*.tsx"
```
Expected: Only the initialization `lastTodoUpdate: null` in `projection.ts:50`. No assignment sites exist.

```bash
cd /root/my-agent-team && grep -rn "todo_update" --include="*.ts" --include="*.tsx" apps/backend/ packages/
```
Expected: Find where `todo_update` events are emitted. Record the result — it determines where the fix goes.

- [ ] **Step 2.2: Determine the todo_update event flow path**

Check if `todo_update` events flow through:
1. `onRunMessage` callback (main.ts:130) — receives `MessageRevision` objects
2. `checkpoint_events` table — receives execution facts from framework

```bash
cd /root/my-agent-team && grep -rn "todo_update\|todoUpdate\|type.*todo" --include="*.ts" packages/framework/ packages/harness/
```

**If `todo_update` flows through `onRunMessage`** (most likely — it's a harness-level event that becomes a MessageRevision with a special type), use Path A below.
**If `todo_update` is written to `checkpoint_events`**, use Path B below.

- [ ] **Step 2.3a (Path A): Add todo_update branch in main.ts onRunMessage callback**

In `apps/backend/src/main.ts`, inside the `supervisor.onRunMessage` callback (around line 145, after `getOrCreateAccumulator` and before the role check), add:

```typescript
  // Update accumulator for terminal processing (onRunComplete)
  const acc = getOrCreateAccumulator(spanId, senderMemberId);

  // B1: Capture todo_update events — they are not messages but drive onRunComplete appendTodo
  if (revision.type === "todo_update") {
    acc.lastTodoUpdate = { todos: (revision as any).todos ?? [] };
    return; // todo_update does not produce a ledger entry or broadcast
  }

  if (revision.role === "assistant") {
    // ... existing code ...
```

- [ ] **Step 2.3b (Path B — if todo_update is in checkpoint_events): Read from checkpointEventsStore in onRunComplete**

In `apps/backend/src/features/conversation/projection.ts`, add a helper and modify `onRunComplete` Phase 3:

```typescript
// New helper (add after getOrCreateAccumulator, around line 56)
function getLastTodoFromEvents(
  checkpointEventsStore: { readBySpan: (sessionId: string, spanId: string) => Array<{ type: string; data: string }> } | undefined,
  sessionId: string,
  spanId: string,
): { todos: unknown } | null {
  if (!checkpointEventsStore) return null;
  const events = checkpointEventsStore.readBySpan(sessionId, spanId);
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.type === "todo_update") {
      try {
        return { todos: JSON.parse(ev.data).todos };
      } catch { return null; }
    }
  }
  return null;
}
```

Then in `onRunComplete` Phase 3 (around line 216), replace the `if (acc.lastTodoUpdate)` check with:

```typescript
  // Phase 3: BEST-EFFORT
  if (acc) {
    clearAccumulator(spanId);
    // Try accumulator first, fall back to checkpoint events
    const todoUpdate = acc.lastTodoUpdate ?? getLastTodoFromEvents(checkpointEventsStore, sessionId, spanId);
    if (todoUpdate) {
      void convSvc
        .appendTodo(cid, acc.senderMemberId, todoUpdate.todos)
        .catch(/* ... */);
    }
    // ... mentionedMemberIds logic unchanged ...
  }
```

- [ ] **Step 2.4: Write the projection test for todo_update**

In `apps/backend/src/features/conversation/projection.test.ts`, add:

```typescript
import { describe, expect, it, mock } from "bun:test";
import { getOrCreateAccumulator, clearAccumulator, onRunComplete } from "./projection.js";

describe("onRunComplete — todo_update projection", () => {
  it("appendTodo is called when lastTodoUpdate was accumulated", async () => {
    const acc = getOrCreateAccumulator("span-t1", "member-1");
    acc.lastTodoUpdate = { todos: [{ id: "t1", text: "do something" }] };

    const appendTodo = mock(async (_cid: string, _memberId: string, _todos: unknown[]) => {});
    const appendLedgerEntry = mock(async () => 1);
    const completeRun = mock(() => {});
    const triggerMentionedAgents = mock(async () => {});

    await onRunComplete(
      "conv-1:member-1",
      "span-t1",
      "succeeded",
      { appendLedgerEntry, appendTodo } as any,
      { completeRun, appendTodo, triggerMentionedAgents } as any,
      { getSpanOrigin: () => null } as any,
      "main",
    );

    expect(appendTodo).toHaveBeenCalledTimes(1);
    // Verify the first call's arguments
    const calls = (appendTodo as any).mock.calls as any[][];
    expect(calls[0]?.[0]).toBe("conv-1");
    expect(calls[0]?.[1]).toBe("member-1");
    expect(calls[0]?.[2]).toEqual([{ id: "t1", text: "do something" }]);
  });

  it("appendTodo is NOT called when lastTodoUpdate is null", async () => {
    getOrCreateAccumulator("span-t2", "member-2"); // lastTodoUpdate stays null

    const appendTodo = mock(async () => {});
    const appendLedgerEntry = mock(async () => 1);
    const completeRun = mock(() => {});
    const triggerMentionedAgents = mock(async () => {});

    await onRunComplete(
      "conv-2:member-2",
      "span-t2",
      "succeeded",
      { appendLedgerEntry } as any,
      { completeRun, appendTodo, triggerMentionedAgents } as any,
      { getSpanOrigin: () => null } as any,
      "main",
    );

    expect(appendTodo).toHaveBeenCalledTimes(0);
  });
});
```

- [ ] **Step 2.5: Run the tests to confirm**

```bash
cd /root/my@chengchenccc/apps/backend && bun test --test-name-pattern="todo_update"
```
Expected: If using Path A, the new tests pass (the main.ts change makes the production path work). If existing projection tests fail due to missing mocks, update them.

- [ ] **Step 2.6: Run full backend test suite**

```bash
cd /root/my@chengchenccc/apps/backend && bun test
```
Expected: All tests pass.

- [ ] **Step 2.7: Commit**

```bash
git add apps/backend/src/main.ts \
        apps/backend/src/features/conversation/projection.ts \
        apps/backend/src/features/conversation/projection.test.ts
git commit -m "fix(B1): connect todo_update events to accumulator for appendTodo

The accumulator's lastTodoUpdate field was declared and consumed (in onRunComplete
Phase 3) but never assigned. This caused all agent todo_updates to be silently
dropped — the conversation todo list was always empty.

Fix: capture todo_update events in the onRunMessage callback (main.ts) and write
them to acc.lastTodoUpdate so onRunComplete's appendTodo has data to write."
```

---

### Task 3: B2 — Fix Frontend Session ID Mismatch + List Aggregation

**Files:**
- Modify: `apps/backend/src/features/runtime-ops/service.ts` (add `getSessionDetail`, `listSessions`)
- Modify: `apps/backend/src/features/runtime-ops/http.ts` (add routes)
- Modify: `apps/backend/src/features/span/http.ts` (add routes)
- Modify: `apps/web/src/lib/api.ts` (add `listOpsSessions`, `getOpsSessionDetail`)
- Modify: `apps/web/src/app/(main)/ops/sessions/page.tsx` (use listOpsSessions)
- Modify: `apps/web/src/app/(main)/ops/sessions/[sessionId]/page.tsx` (use getOpsSessionDetail)
- Create: `apps/backend/src/features/runtime-ops/service.test.ts` (add tests)

#### 3A: Backend — New Session APIs

- [ ] **Step 3.1: Add SessionRow and SessionDetail types**

In `apps/backend/src/features/runtime-ops/service.ts`, add after the existing type definitions (after line 63):

```typescript
/** Summary row for the sessions list page — one row per sessionId. */
export interface SessionRow {
  sessionId: string;
  agentId: string;
  spanCount: number;
  lastSpanAt: number | null;
  /** Derived: "running" if any span is running, else "done" if all succeeded/error/interrupted */
  status: "running" | "done";
}

/** Aggregate detail for /ops/sessions/:sessionId — shows all spans in this session. */
export interface SessionDetail {
  sessionId: string;
  agentId: string;
  status: "running" | "done";
  spanCount: number;
  spans: SpanSummary[];
}

export interface SpanSummary {
  spanId: string;
  status: string;
  kind: string;
  startedAt: number | null;
  endedAt: number | null;
}
```

- [ ] **Step 3.2: Write the test for listSessions and getSessionDetail**

Create or add to `apps/backend/src/features/runtime-ops/service.test.ts`:

```typescript
import { describe, expect, it, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { RuntimeOpsStore } from "./store.js";
import { createRuntimeOpsService } from "./service.js";
import { runEventsDbMigrations } from "../span/events-db-migrations.js";

function setup() {
  const db = new Database(":memory:");
  runEventsDbMigrations(db);
  const opsStore = new RuntimeOpsStore(db);
  const svc = createRuntimeOpsService({
    db,
    opsStore,
    supervisor: { cancel: () => {}, onRunComplete: () => {}, onRunMessage: () => {} } as any,
    heartbeatTimeoutMs: 30000,
  });
  return { db, opsStore, svc };
}

describe("listSessions", () => {
  it("groups runs by session_id", () => {
    const { db, svc } = setup();

    // Insert 3 spans: 2 in session-A, 1 in session-B
    db.run(`INSERT INTO run (span_id, session_id, status, kind, agent_id, started_at, ended_at)
            VALUES ('sp1', 'sess-a', 'succeeded', 'main', 'agent-1', 1000, 2000)`);
    db.run(`INSERT INTO run (span_id, session_id, status, kind, agent_id, started_at, ended_at)
            VALUES ('sp2', 'sess-a', 'running', 'main', 'agent-1', 3000, NULL)`);
    db.run(`INSERT INTO run (span_id, session_id, status, kind, agent_id, started_at, ended_at)
            VALUES ('sp3', 'sess-b', 'succeeded', 'main', 'agent-2', 1500, 2500)`);

    const sessions = svc.listSessions({ limit: 10 });
    expect(sessions).toHaveLength(2);

    const sessA = sessions.find((s: any) => s.sessionId === "sess-a")!;
    expect(sessA.spanCount).toBe(2);
    expect(sessA.status).toBe("running"); // has one running span
    expect(sessA.agentId).toBe("agent-1");

    const sessB = sessions.find((s: any) => s.sessionId === "sess-b")!;
    expect(sessB.spanCount).toBe(1);
    expect(sessB.status).toBe("done");
  });

  it("returns empty array when no runs exist", () => {
    const { svc } = setup();
    expect(svc.listSessions({ limit: 10 })).toEqual([]);
  });
});

describe("getSessionDetail", () => {
  it("returns spans for a session ordered by started_at DESC", () => {
    const { db, svc } = setup();

    db.run(`INSERT INTO run (span_id, session_id, status, kind, agent_id, started_at, ended_at)
            VALUES ('sp1', 'sess-x', 'succeeded', 'main', 'agent-1', 1000, 2000)`);
    db.run(`INSERT INTO run (span_id, session_id, status, kind, agent_id, started_at, ended_at)
            VALUES ('sp2', 'sess-x', 'interrupted', 'main', 'agent-1', 3000, 3500)`);

    const detail = svc.getSessionDetail("sess-x");
    expect(detail).not.toBeNull();
    expect(detail!.sessionId).toBe("sess-x");
    expect(detail!.spanCount).toBe(2);
    expect(detail!.spans).toHaveLength(2);
    expect(detail!.spans[0]!.spanId).toBe("sp2"); // most recent first
  });

  it("returns null for unknown session", () => {
    const { svc } = setup();
    expect(svc.getSessionDetail("nonexistent")).toBeNull();
  });
});
```

- [ ] **Step 3.3: Run the test — should fail (methods not implemented)**

```bash
cd /root/my@chengchenccc/apps/backend && bun test --test-name-pattern="listSessions|getSessionDetail"
```
Expected: FAIL — TypeScript compilation error or runtime error because `listSessions` and `getSessionDetail` don't exist on the service yet.

- [ ] **Step 3.4: Implement listSessions and getSessionDetail in service.ts**

In `apps/backend/src/features/runtime-ops/service.ts`, add these methods inside the object returned by `createRuntimeOpsService` (after the `listRuns` method, around line 207):

```typescript
    // ── Session-level aggregation (B2: /ops/sessions) ──────────

    listSessions(params: { limit?: number; agentId?: string; status?: string }): SessionRow[] {
      let sql = `SELECT session_id,
                        MAX(started_at) AS last_span_at,
                        COUNT(*) AS span_count,
                        MAX(agent_id) AS agent_id
                   FROM run`;
      const conditions: string[] = [];
      const bindings: unknown[] = [];
      if (params.agentId) {
        conditions.push("agent_id = ?");
        bindings.push(params.agentId);
      }
      if (params.status) {
        conditions.push("status = ?");
        bindings.push(params.status);
      }
      if (conditions.length > 0) {
        sql += " WHERE " + conditions.join(" AND ");
      }
      sql += " GROUP BY session_id ORDER BY last_span_at DESC";
      if (params.limit) {
        sql += " LIMIT ?";
        bindings.push(params.limit);
      }
      const rows = db.query(sql).all(...bindings) as Array<{
        session_id: string;
        last_span_at: number | null;
        span_count: number;
        agent_id: string;
      }>;
      return rows.map((r) => ({
        sessionId: r.session_id,
        agentId: r.agent_id,
        spanCount: r.span_count,
        lastSpanAt: r.last_span_at,
        status: deriveSessionStatusFromDb(r.session_id),
      }));
    },

    getSessionDetail(sessionId: string): SessionDetail | null {
      const spans = db
        .query(
          `SELECT span_id, status, kind, agent_id, started_at, ended_at
             FROM run WHERE session_id = ? ORDER BY started_at DESC`,
        )
        .all(sessionId) as Array<{
        span_id: string;
        status: string;
        kind: string;
        agent_id: string;
        started_at: number | null;
        ended_at: number | null;
      }>;
      if (spans.length === 0) return null;
      return {
        sessionId,
        agentId: spans[0]!.agent_id,
        status: spans.some((s) => s.status === "running") ? "running" : "done",
        spanCount: spans.length,
        spans: spans.map((s) => ({
          spanId: s.span_id,
          status: s.status,
          kind: s.kind,
          startedAt: s.started_at,
          endedAt: s.ended_at,
        })),
      };
    },
```

And add the helper function at module scope (before `createRuntimeOpsService`):

```typescript
function deriveSessionStatusFromDb(db: Database, sessionId: string): "running" | "done" {
  const running = db
    .query("SELECT 1 FROM run WHERE session_id = ? AND status = 'running' LIMIT 1")
    .get(sessionId);
  return running ? "running" : "done";
}
```

Note: Since `deriveSessionStatusFromDb` needs the `db` instance and is called from `listSessions` which already has it in scope, inline it instead:

```typescript
    listSessions(params: { limit?: number; agentId?: string; status?: string }): SessionRow[] {
      // ... SQL as above ...
      return rows.map((r) => {
        const running = db
          .query("SELECT 1 FROM run WHERE session_id = ? AND status = 'running' LIMIT 1")
          .get(r.session_id);
        return {
          sessionId: r.session_id,
          agentId: r.agent_id,
          spanCount: r.span_count,
          lastSpanAt: r.last_span_at,
          status: running ? "running" : "done",
        };
      });
    },
```

- [ ] **Step 3.5: Run the test — should pass**

```bash
cd /root/my@chengchenccc/apps/backend && bun test --test-name-pattern="listSessions|getSessionDetail"
```
Expected: PASS.

- [ ] **Step 3.6: Add HTTP routes for the new session APIs**

In `apps/backend/src/features/runtime-ops/http.ts` (or the ops router file), add two new routes:

```typescript
// GET /api/ops/sessions — session-level list (aggregated)
router.get("/ops/sessions", (req) => {
  const url = new URL(req.url);
  const agentId = url.searchParams.get("agentId") ?? undefined;
  const status = url.searchParams.get("status") ?? undefined;
  const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : 100;
  const sessions = opsSvc.listSessions({ limit, agentId, status });
  return Response.json(sessions);
});

// GET /api/ops/sessions/:sessionId — session detail with span list
router.get("/ops/sessions/:sessionId", (req, params) => {
  const detail = opsSvc.getSessionDetail(params.sessionId);
  if (!detail) return new Response("Session not found", { status: 404 });
  return Response.json(detail);
});
```

If the router is defined in `main.ts` with the Elysia pattern, add routes there. Find the existing `ops/runs` routes in `main.ts` and add the session routes nearby.

- [ ] **Step 3.7: Commit backend changes**

```bash
git add apps/backend/src/features/runtime-ops/service.ts \
        apps/backend/src/features/runtime-ops/service.test.ts \
        apps/backend/src/main.ts  # if routes added here
git commit -m "feat(B2): add session-level aggregation APIs (listSessions, getSessionDetail)

Adds two new backend endpoints:
- GET /api/ops/sessions — groups runs by sessionId (one row per memory line)
- GET /api/ops/sessions/:sessionId — returns session detail with span list

This fixes the URL semantics mismatch where /ops/sessions/:sessionId was
incorrectly looking up by spanId instead of sessionId."
```

#### 3B: Frontend — Session List Page

- [ ] **Step 3.8: Add listOpsSessions and getOpsSessionDetail to the frontend API client**

In `apps/web/src/lib/api.ts`, add after `listOpsRuns` (around line 289):

```typescript
  listOpsSessions: (params?: {
    agentId?: string;
    status?: string;
    limit?: number;
  }) => {
    const qs = new URLSearchParams();
    if (params?.agentId) qs.set("agentId", params.agentId);
    if (params?.status) qs.set("status", params.status);
    if (params?.limit) qs.set("limit", String(params.limit));
    const q = qs.toString();
    return apiFetch<SessionRow[]>(`ops/sessions${q ? `?${q}` : ""}`);
  },

  getOpsSessionDetail: (sessionId: string) =>
    apiFetch<SessionDetail>(`ops/sessions/${sessionId}`),
```

Add the types after the existing ops types (around line 447):

```typescript
export interface SessionRow {
  sessionId: string;
  agentId: string;
  spanCount: number;
  lastSpanAt: number | null;
  status: "running" | "done";
}

export interface SessionDetail {
  sessionId: string;
  agentId: string;
  status: "running" | "done";
  spanCount: number;
  spans: SpanSummary[];
}

export interface SpanSummary {
  spanId: string;
  status: string;
  kind: string;
  startedAt: number | null;
  endedAt: number | null;
}
```

- [ ] **Step 3.9: Update the sessions list page to use listOpsSessions**

In `apps/web/src/app/(main)/ops/sessions/page.tsx`, change lines 73-84:

```typescript
// BEFORE:
const listQuery = useQuery({
  queryKey: ["ops", "runs", { status, transport, heartbeat }],
  queryFn: () => api.listOpsRuns({ status, limit: 100 }),
  // ...
});

// AFTER:
const listQuery = useQuery({
  queryKey: ["ops", "sessions", { status }],
  queryFn: () => api.listOpsSessions({ status, limit: 100 }),
  staleTime: 10_000,
  refetchInterval: 30_000,
});
```

Update the table columns to show session-level data:
- `sessionId` (primary column, links to `/ops/sessions/${sessionId}`)
- `agentId` (which agent)
- `spanCount` (number of spans in this session)
- `lastSpanAt` (most recent activity)
- `status` (running/done)

Replace `RunOpsTable` usage with a session-appropriate table. The table component may need a new `SessionListTable` or the existing `RunOpsTable` can be adapted to render session rows (the field mapping is different).

- [ ] **Step 3.10: Update the session detail page to use getOpsSessionDetail**

In `apps/web/src/app/(main)/ops/sessions/[sessionId]/page.tsx`, change line 22-27:

```typescript
// BEFORE:
const detailQuery = useQuery({
  queryKey: ["ops", "sessionDetail", sessionId],
  queryFn: () => api.getOpsRunDetail(sessionId),
  // ...
});

// AFTER:
const detailQuery = useQuery({
  queryKey: ["ops", "sessionDetail", sessionId],
  queryFn: () => api.getOpsSessionDetail(sessionId),
  enabled: !!sessionId,
  refetchInterval: (query) => query.state.data?.status === "running" ? 10_000 : false,
});
```

Replace the detail rendering (lines 54-116) to show:
1. Session header (sessionId, agentId, status, span count)
2. Span list (each row = one span with spanId, status, kind, startedAt, endedAt)
3. Clicking a span opens its detail/insights (pass `selectedSpanId` to `RunInsightsPanel`)

Change line 59 from:
```typescript
<RunInsightsPanel runId={sessionId} ... />
```
To:
```typescript
{selectedSpanId && <RunInsightsPanel runId={selectedSpanId} ... />}
```

- [ ] **Step 3.11: Run frontend typecheck**

```bash
cd /root/my@chengchenccc/apps/web && bun run typecheck
```
Expected: zero type errors.

- [ ] **Step 3.12: Commit frontend changes**

```bash
git add apps/web/src/lib/api.ts \
        apps/web/src/app/\(main\)/ops/sessions/page.tsx \
        apps/web/src/app/\(main\)/ops/sessions/\[sessionId\]/page.tsx
git commit -m "feat(B2): fix frontend session id alignment and list aggregation

- Add listOpsSessions / getOpsSessionDetail to API client
- Update /ops/sessions page to show session-level aggregation (groupBy sessionId)
- Update /ops/sessions/:sessionId to show span list for that session
- Fix: sessionId was being passed as spanId to getOpsRunDetail (404/no data)
- RunInsightsPanel now receives selectedSpanId from user click, not URL sessionId"
```

---

### Task 4: PR-1 Integration Verification

- [ ] **Step 4.1: Run full typecheck across all packages**

```bash
cd /root/my-agent-team && bun run typecheck
```
Expected: zero errors.

- [ ] **Step 4.2: Run full test suite**

```bash
cd /root/my-agent-team && bun run test
```
Expected: all tests pass.

- [ ] **Step 4.3: Manual smoke test (if backend is running)**

Start backend and verify:
1. `GET /api/ops/sessions` returns session-aggregated list
2. `GET /api/ops/sessions/:sessionId` returns span list
3. `GET /api/ops/sessions/:sessionId/spans/:spanId/insights` does NOT 500 (B0 fix)

- [ ] **Step 4.4: Merge PR-1 to feature branch or push for review**

```bash
git push origin fix/storage-bugs-b0-b1-b2
```

---

## PR-2: Storage Convergence (S1, S2, S3, S4)

> **IMPORTANT:** All schema changes in this PR must be done together before running `drizzle-kit generate` ONCE. Schema changes are interdependent — doing them separately would require multiple migration generations which increases risk.

- [ ] **Step 4.5: Create branch from PR-1**

```bash
git checkout fix/storage-bugs-b0-b1-b2
git checkout -b feat/storage-convergence
```

---

### Task 5: S2 — Delete projection_messages

**Files:**
- Modify: `apps/backend/src/infra/db/schema.ts:86-91`
- Modify: `apps/backend/src/features/agent/adapter-sqlite.ts:140-152`

- [ ] **Step 5.1: Delete the projection_messages table definition**

In `apps/backend/src/infra/db/schema.ts`, delete lines 86-91:

```typescript
// DELETE these lines:
export const projectionMessages = sqliteTable("projection_messages", {
  sessionId: text().primaryKey(),
  messages: text().notNull(),
  updatedAt: integer({ mode: "number" }).notNull(),
});
```

- [ ] **Step 5.2: Delete the orphan cleanup in agent adapter-sqlite.ts**

In `apps/backend/src/features/agent/adapter-sqlite.ts`, delete lines 140-152 (the projection_messages DELETE loop):

```typescript
// DELETE this block:
    // Delete projection_messages by thread ID
    const threadRows = db
      .query("SELECT conversation_id || ':' || member_id AS id FROM member WHERE agent_id = ?")
      .all(id) as { id: string }[];
    const sessionIds = threadRows.map((r) => r.id);
    const deletedThreads = sessionIds.length;
    for (const tid of sessionIds) {
      db.run("DELETE FROM projection_messages WHERE session_id = ?", [tid]);
    }
```

Also update the `deletedThreads` variable — if it was only used for projection_messages, remove it entirely or replace with 0. Check the return type of `hardDelete`:

```typescript
// The return value may need updating:
return { deletedAgent: true, deletedThreads: 0, deletedMembers };
```

- [ ] **Step 5.3: Verify no remaining references**

```bash
cd /root/my-agent-team && grep -rn "projection_messages\|projectionMessages" --include="*.ts" --include="*.tsx" apps/ packages/
```
Expected: zero matches.

- [ ] **Step 5.4: Commit**

```bash
git add apps/backend/src/infra/db/schema.ts \
        apps/backend/src/features/agent/adapter-sqlite.ts
git commit -m "feat(S2): delete projection_messages table (third copy of messages)

projection_messages had zero writers and zero readers — the only reference was
an orphan DELETE in agent adapter-sqlite.ts. The canonical message stores are:
- conversation_ledger (product truth, append-only)
- checkpoint_messages (framework working state)

Drops the redundant third copy per storage convergence spec."
```

---

### Task 6: S3 — Delete runner_health + Narrow RunOpsEventKind (15→3)

**Files:**
- Modify: `apps/backend/src/infra/db/events-schema.ts:94-105` (delete runner_health)
- Modify: `apps/backend/src/features/runtime-ops/types.ts:20-35` (narrow enum)
- Modify: `apps/backend/src/features/runtime-ops/store.test.ts` (remove dead kind assertions)

- [ ] **Step 6.1: Delete runner_health table from schema**

In `apps/backend/src/infra/db/events-schema.ts`, delete lines 94-105:

```typescript
// DELETE these lines:
export const runnerHealth = sqliteTable("runner_health", {
  agentId: text().primaryKey(),
  lastSeenAt: integer({ mode: "number" }).notNull(),
  uptimeMs: integer({ mode: "number" }).notNull().default(0),
  activeRunCount: integer().notNull().default(0),
  activeRunIds: text().notNull().default("[]"),
  checkpointerOk: integer({ mode: "boolean" }).notNull().default(true),
  workspaceOk: integer({ mode: "boolean" }).notNull().default(true),
  lastError: text(),
  updatedAt: integer({ mode: "number" }).notNull(),
});
```

- [ ] **Step 6.2: Verify no remaining runner_health references**

```bash
cd /root/my-agent-team && grep -rn "runner_health\|runnerHealth\|RunnerHealth" --include="*.ts" --include="*.tsx" apps/ packages/
```
Expected: zero matches. If there are matches in `store.ts` or `service.ts`, remove them.

- [ ] **Step 6.3: Narrow RunOpsEventKind from 15 values to 3**

In `apps/backend/src/features/runtime-ops/types.ts`, replace lines 20-35:

```typescript
// BEFORE:
export type RunOpsEventKind =
  | "attempt_started"
  | "attempt_transport_seen"
  | "delta_pushed"
  | "run_done_received"
  | "run_finalized_sent"
  | "cancel_requested"
  | "abort_sent"
  | "reattach_started"
  | "reattach_succeeded"
  | "reattach_failed"
  | "reaper_marked_interrupted"
  | "projection_degraded"
  | "recover_requested"
  | "retry_requested"
  | "retry_started";

// AFTER:
export type RunOpsEventKind =
  | "projection_degraded"  // supervisor.ts:157 — critical sink (ledger terminal write) failed
  | "retry_requested"      // scheduler.ts:139
  | "retry_started";       // scheduler.ts:152
```

- [ ] **Step 6.4: Compile-check — dead kind references will fail TypeScript**

```bash
cd /root/my@chengchenccc/apps/backend && bun run typecheck
```
Expected: If any code references the 12 removed kind values, TypeScript compilation will fail. Fix each one by removing the reference.

- [ ] **Step 6.5: Update store.test.ts — remove dead kind assertions**

Search for and remove any test assertions that use the 12 removed kind values:

```bash
cd /root/my-agent-team && grep -rn "attempt_started\|attempt_transport_seen\|delta_pushed\|run_done_received\|run_finalized_sent\|abort_sent\|reattach_started\|reattach_succeeded\|reattach_failed\|reaper_marked_interrupted\|recover_requested" --include="*.test.ts" --include="*.ts"
```

Delete or update each matching test. If a test was testing the old kind values specifically, remove that test.

- [ ] **Step 6.6: Commit**

```bash
git add apps/backend/src/infra/db/events-schema.ts \
        apps/backend/src/features/runtime-ops/types.ts
# Add any test files that were updated
git commit -m "feat(S3): delete runner_health table + narrow RunOpsEventKind 15→3

- Delete runner_health: dead table from runner daemon era, zero readers/writers
- Narrow RunOpsEventKind: only 3 values are actually emitted (projection_degraded,
  retry_requested, retry_started). Remaining 12 were runner/reattach-era vocabulary
  that was never written to the database.

No data migration needed for kind narrowing: the column is bare TEXT without
CHECK constraints, so old rows with dead kind values are still readable."
```

---

### Task 7: S4 — Rename run_ops_event → control_plane_event

**Files:**
- Modify: `apps/backend/src/infra/db/events-schema.ts:50-65` (table definition + indexes)
- Modify: `apps/backend/src/features/runtime-ops/store.ts` (all `runOpsEvent` references)
- Modify: `apps/web/src/app/(main)/ops/sessions/[sessionId]/TraceWaterfall.tsx:33` (comment string)
- Modify: `docs/architecture/data-model.md`, `overview.md`, `identifiers.md`, `system-overview.md`

- [ ] **Step 7.1: Rename table in events-schema.ts**

In `apps/backend/src/infra/db/events-schema.ts`, change lines 50-65:

```typescript
// BEFORE:
export const runOpsEvent = sqliteTable("run_ops_event", {
  seq: integer().primaryKey({ autoIncrement: true }),
  spanId: text("span_id").notNull(),
  attemptSeq: integer("attempt_seq"),
  kind: text().notNull(),
  payload: text().notNull().default("{}"),
  traceId: text("trace_id"),
  ts: integer({ mode: "number" }).notNull().default(sql`(unixepoch('subsec') * 1000)`),
}, (table) => [
  index("idx_run_ops_event_span").on(table.spanId, table.seq),
  index("idx_run_ops_event_trace").on(table.traceId, table.seq),
  index("idx_run_ops_event_kind").on(table.kind, table.ts.desc()),
]);

// AFTER:
export const controlPlaneEvent = sqliteTable("control_plane_event", {
  seq: integer().primaryKey({ autoIncrement: true }),
  spanId: text("span_id").notNull(),
  attemptSeq: integer("attempt_seq"),
  kind: text().notNull(),
  payload: text().notNull().default("{}"),
  traceId: text("trace_id"),
  ts: integer({ mode: "number" }).notNull().default(sql`(unixepoch('subsec') * 1000)`),
}, (table) => [
  index("idx_control_plane_event_span").on(table.spanId, table.seq),
  index("idx_control_plane_event_trace").on(table.traceId, table.seq),
  index("idx_control_plane_event_kind").on(table.kind, table.ts.desc()),
]);
```

- [ ] **Step 7.2: Update all references in store.ts**

In `apps/backend/src/features/runtime-ops/store.ts`:

```typescript
// BEFORE (line 14 — import usage):
// All references to schema.runOpsEvent → change to schema.controlPlaneEvent

// Line 73: schema.runOpsEvent → schema.controlPlaneEvent
// Line 82: schema.runOpsEvent → schema.controlPlaneEvent
// Line 90-92: schema.runOpsEvent → schema.controlPlaneEvent
// Line 100-102: schema.runOpsEvent → schema.controlPlaneEvent
```

Do a find-and-replace: `schema.runOpsEvent` → `schema.controlPlaneEvent` in this file.

- [ ] **Step 7.3: Update comment string in TraceWaterfall.tsx**

In `apps/web/src/app/(main)/ops/sessions/[sessionId]/TraceWaterfall.tsx:33`:

```typescript
// BEFORE:
// "run_ops_event data"
// AFTER:
// "control_plane_event data"
```

- [ ] **Step 7.4: Write the hand-written migration SQL**

Create `apps/backend/drizzle/backend/XXXX_rename_run_ops_event.sql` (the migration file that drizzle-kit will generate — but we'll hand-write the RENAME part):

```sql
-- Manual migration: rename run_ops_event → control_plane_event
-- This MUST be hand-written because drizzle-kit may generate DROP+CREATE which loses data.
ALTER TABLE run_ops_event RENAME TO control_plane_event;

-- Rebuild indexes with new names (SQLite RENAME TABLE carries indexes but keeps old names)
DROP INDEX IF EXISTS idx_run_ops_event_span;
DROP INDEX IF EXISTS idx_run_ops_event_trace;
DROP INDEX IF EXISTS idx_run_ops_event_kind;
CREATE INDEX idx_control_plane_event_span  ON control_plane_event (span_id, seq);
CREATE INDEX idx_control_plane_event_trace ON control_plane_event (trace_id, seq);
CREATE INDEX idx_control_plane_event_kind  ON control_plane_event (kind, ts DESC);
```

> **Note for fresh environments:** When running `gen-drizzle.sh` on an empty DB (no prior events.db), drizzle will CREATE TABLE with the new name `control_plane_event` directly — no RENAME needed. The manual ALTER is only for environments with existing data.

- [ ] **Step 7.5: Update living architecture docs**

In `docs/architecture/data-model.md`: replace `run_ops_event` → `control_plane_event`
In `docs/architecture/overview.md`: replace `run_ops_event` → `control_plane_event`
In `docs/architecture/identifiers.md`: replace `run_ops_event` → `control_plane_event`
In `docs/architecture/system-overview.md`: replace `run_ops_event` → `control_plane_event`

**Do NOT** modify files in `docs/superpowers/specs/`, `docs/superpowers/retros/`, `docs/superpowers/plans/` — those are archived historical records.

- [ ] **Step 7.6: Run typecheck to catch any missed references**

```bash
cd /root/my-agent-team && bun run typecheck
```
Expected: zero errors (TypeScript will catch any remaining `runOpsEvent` references).

- [ ] **Step 7.7: Run full test suite**

```bash
cd /root/my-agent-team && bun run test
```
Expected: all tests pass. Fix any that reference the old table/index names.

- [ ] **Step 7.8: Final grep verification**

```bash
cd /root/my-agent-team && grep -rn "run_ops_event\|runOpsEvent" --include="*.ts" --include="*.tsx" --include="*.md" apps/ packages/ docs/architecture/
```
Expected: Only the hand-written migration SQL file shows `run_ops_event` (in the ALTER statement). All other matches should be in archived historical docs only.

- [ ] **Step 7.9: Commit**

```bash
git add apps/backend/src/infra/db/events-schema.ts \
        apps/backend/src/features/runtime-ops/store.ts \
        apps/web/src/app/\(main\)/ops/sessions/\[sessionId\]/TraceWaterfall.tsx \
        docs/architecture/data-model.md \
        docs/architecture/overview.md \
        docs/architecture/identifiers.md \
        docs/architecture/system-overview.md \
        apps/backend/drizzle/backend/
git commit -m "feat(S4): rename run_ops_event table → control_plane_event

Physical table rename to align name with semantic meaning:
- run_ops_event was a double-historical-baggage name (run-era + ops signal)
- control_plane_event reflects its actual role: control plane events
  (projection degraded, retry scheduling) alongside checkpoint_events
  (execution facts) and conversation_ledger (domain truth).

Includes:
- Drizzle symbol: runOpsEvent → controlPlaneEvent
- Table string: 'run_ops_event' → 'control_plane_event'
- 3 indexes renamed accordingly
- Hand-written ALTER TABLE RENAME migration (avoids drizzle drop+recreate)
- Living architecture docs updated (historical archived docs unchanged)"
```

---

### Task 8: S1 — Merge events.db into backend.db

**Files:**
- Modify: `apps/backend/src/infra/db/schema.ts` (add events 6 tables)
- Delete: `apps/backend/src/infra/db/events-schema.ts` (merged into schema.ts)
- Modify: `apps/backend/src/main.ts` (remove eventsDb, wire everything to db)
- Delete: `apps/backend/src/features/span/events-db-migrations.ts`
- Delete: `apps/backend/drizzle.events.config.ts`
- Modify: `scripts/gen-drizzle.sh` (remove events generate line)
- Modify: `apps/backend/src/features/runtime-ops/store.ts` (import from schema.ts not events-schema.ts)
- Modify: `apps/backend/src/features/span/supervisor.ts` (remove eventsDb import, use db)
- Modify: Test files that use `runEventsDbMigrations`

- [ ] **Step 8.1: Merge events-schema.ts table definitions into schema.ts**

Copy the remaining 6 table definitions from `apps/backend/src/infra/db/events-schema.ts` into `apps/backend/src/infra/db/schema.ts`:

Add after the last existing table definition in schema.ts (after the `deliverable` table):

```typescript
// ── Tables migrated from events-schema.ts (formerly events.db, now part of backend.db) ──

export const run = sqliteTable("run", {
  spanId: text("span_id").primaryKey(),
  sessionId: text("session_id").notNull(),
  status: text().notNull().default("running"),
  kind: text().notNull().default("main"),
  parentSpanId: text("parent_span_id"),
  agentId: text("agent_id").notNull().default(""),
  degradedReason: text("degraded_reason"),
  startedAt: integer("started_at", { mode: "number" }).notNull().default(sql`(unixepoch('subsec') * 1000)`),
  endedAt: integer("ended_at", { mode: "number" }),
}, (table) => [
  index("idx_run_session").on(table.sessionId, table.startedAt.desc()),
]);

export const attempt = sqliteTable("attempt", {
  spanId: text("span_id").notNull().references(() => run.spanId, { onDelete: "cascade" }),
  seq: integer().notNull(),
  startedAt: integer("started_at", { mode: "number" }).notNull().default(sql`(unixepoch('subsec') * 1000)`),
  endedAt: integer("ended_at", { mode: "number" }),
  heartbeatAt: integer("heartbeat_at", { mode: "number" }),
  transportKind: text("transport_kind"),
  transportHeartbeatAt: integer("transport_heartbeat_at", { mode: "number" }),
}, (table) => [
  primaryKey({ columns: [table.spanId, table.seq] }),
]);

export const controlPlaneEvent = sqliteTable("control_plane_event", {
  seq: integer().primaryKey({ autoIncrement: true }),
  spanId: text("span_id").notNull(),
  attemptSeq: integer("attempt_seq"),
  kind: text().notNull(),
  payload: text().notNull().default("{}"),
  traceId: text("trace_id"),
  ts: integer({ mode: "number" }).notNull().default(sql`(unixepoch('subsec') * 1000)`),
}, (table) => [
  index("idx_control_plane_event_span").on(table.spanId, table.seq),
  index("idx_control_plane_event_trace").on(table.traceId, table.seq),
  index("idx_control_plane_event_kind").on(table.kind, table.ts.desc()),
]);

export const spanOrigin = sqliteTable("span_origin", {
  spanId: text("span_id").primaryKey(),
  conversationId: text("conversation_id"),
  sourceLedgerSeq: integer("source_ledger_seq"),
  agentMemberId: text("agent_member_id"),
  surface: text(),
  traceId: text("trace_id"),
  traceparent: text(),
  idempotencyKey: text("idempotency_key").notNull(),
  issueId: text("issue_id"),
  cronJobId: text("cron_job_id"),
  fromStatus: text("from_status"),
  originKind: text("origin_kind").notNull(),
  createdAt: integer("created_at", { mode: "number" }).notNull().default(sql`(unixepoch('subsec') * 1000)`),
}, (table) => [
  uniqueIndex("idx_span_origin_idempotency").on(table.idempotencyKey),
]);

export const surfaceHealth = sqliteTable("surface_health", {
  agentId: text("agent_id").notNull(),
  surface: text().notNull(),
  lastSeenAt: integer("last_seen_at", { mode: "number" }).notNull().default(sql`(unixepoch('subsec') * 1000)`),
  status: text().notNull().default("ok"),
  error: text(),
  heartbeatIntervalMs: integer("heartbeat_interval_ms"),
}, (table) => [
  primaryKey({ columns: [table.agentId, table.surface] }),
]);

export const issueEvent = sqliteTable("issue_event", {
  seq: integer().primaryKey({ autoIncrement: true }),
  issueId: text("issue_id").notNull(),
  kind: text().notNull(),
  payload: text().notNull().default("{}"),
  ts: integer({ mode: "number" }).notNull().default(sql`(unixepoch('subsec') * 1000)`),
}, (table) => [
  index("idx_issue_event_issue").on(table.issueId, table.ts.desc()),
]);
```

Note: The `run_origin` table from events-schema.ts was already renamed to `span_origin` in 33d1e392. Verify the exact column names from the current `events-schema.ts` when merging.

- [ ] **Step 8.2: Delete events-schema.ts**

```bash
rm apps/backend/src/infra/db/events-schema.ts
```

- [ ] **Step 8.3: Update store.ts — import from schema.ts instead of events-schema.ts**

In `apps/backend/src/features/runtime-ops/store.ts`, change the import:

```typescript
// BEFORE:
import * as schema from "../../infra/db/events-schema.js";

// AFTER:
import * as schema from "../../infra/db/schema.js";
```

- [ ] **Step 8.4: Update supervisor.ts — remove events-db-migrations import, use db from constructor**

In `apps/backend/src/features/span/supervisor.ts`, change the import and constructor:

```typescript
// BEFORE (line 7):
import { runEventsDbMigrations } from "./events-db-migrations.js";

// DELETE line 7.

// In constructor (lines 42-48), BEFORE:
constructor(opts: SpanSupervisorOptions) {
  this.#db = opts.db;
  this.#db.exec("PRAGMA journal_mode=WAL");
  runEventsDbMigrations(this.#db);
  // ...
}

// AFTER:
constructor(opts: SpanSupervisorOptions) {
  this.#db = opts.db;
  // WAL + schema migrations are handled by openDb() in main.ts.
  // This constructor no longer manages its own schema.
  // ...
}
```

- [ ] **Step 8.5: Delete events-db-migrations.ts**

```bash
rm apps/backend/src/features/span/events-db-migrations.ts
```

- [ ] **Step 8.6: Rewire main.ts — remove eventsDb, everything uses db**

In `apps/backend/src/main.ts`:

```typescript
// BEFORE (lines 68-75):
const eventsDb = new Database(`${config.dataDir}/events.db`);
eventsDb.exec("PRAGMA journal_mode=WAL");
eventsDb.exec("PRAGMA busy_timeout=5000");
runEventsDbMigrations(eventsDb);
const opsStore = new RuntimeOpsStore(eventsDb);

// AFTER:
// events.db tables are now in backend.db — single connection
const opsStore = new RuntimeOpsStore(db);
```

Update the supervisor construction (around line 85-91):

```typescript
// BEFORE:
const supervisor = new SpanSupervisor({ config, opsStore, tracer, db: eventsDb, onReap: ... });

// AFTER:
const supervisor = new SpanSupervisor({ config, opsStore, tracer, db, onReap: ... });
```

Update the ops service construction (around line 228):

```typescript
// BEFORE:
const opsSvc = createRuntimeOpsService({ db: eventsDb, opsStore, supervisor, ... });

// AFTER:
const opsSvc = createRuntimeOpsService({ db, opsStore, supervisor, ... });
```

Remove the import for `runEventsDbMigrations` (line 52):

```typescript
// DELETE:
import { runEventsDbMigrations } from "./features/span/events-db-migrations.js";
```

- [ ] **Step 8.7: Update the server shutdown sequence**

In `apps/backend/src/main.ts`, find the shutdown code (around line 368) and simplify:

```typescript
// BEFORE (approximate):
cron.dispose();
supervisor.dispose();
eventsDb.close();
db.close();

// AFTER:
cron.dispose();
supervisor.dispose();
db.close(); // single close — all tables are in backend.db now
```

- [ ] **Step 8.8: Delete drizzle.events.config.ts**

```bash
rm apps/backend/drizzle.events.config.ts
```

- [ ] **Step 8.9: Update gen-drizzle.sh**

In `/root/my@chengchenccc/scripts/gen-drizzle.sh`, delete line 10:

```bash
# BEFORE:
cd apps/backend
bunx drizzle-kit generate --config drizzle.backend.config.ts
bunx drizzle-kit generate --config drizzle.events.config.ts   # ← DELETE THIS LINE

# AFTER:
cd apps/backend
bunx drizzle-kit generate --config drizzle.backend.config.ts
```

- [ ] **Step 8.10: Update test files — replace runEventsDbMigrations with openDb**

In `apps/backend/src/features/runtime-ops/store.test.ts`:

```typescript
// BEFORE:
import { runEventsDbMigrations } from "../span/events-db-migrations.js";
// ...
const db = new Database(":memory:");
runEventsDbMigrations(db);
const store = new RuntimeOpsStore(db);

// AFTER:
import { openDb } from "../../infra/sqlite/db.js";
// ...
const db = openDb(":memory:");
const store = new RuntimeOpsStore(db);
```

In `apps/backend/src/features/runtime-ops/insights.test.ts`: No change needed — it uses `fakeCheckpointEventsStore` which is in-memory. But verify.

In `apps/backend/src/features/span/supervisor.test.ts`: Update if it calls `runEventsDbMigrations`.

- [ ] **Step 8.11: Run typecheck to catch all broken imports**

```bash
cd /root/my-agent-team && bun run typecheck
```
Expected: zero errors. Fix any broken imports.

- [ ] **Step 8.12: Run full test suite**

```bash
cd /root/my-agent-team && bun run test
```
Expected: all tests pass.

- [ ] **Step 8.13: Verify only 2 DB files are opened at startup**

```bash
cd /root/my-agent-team && grep -rn "new Database\|openDb" apps/backend/src/main.ts
```
Expected: Two connections — `openDb(...backend.db)` and `new Database(...checkpointer.db, { readonly: true })`. No `events.db` references.

- [ ] **Step 8.14: Run drizzle-kit generate ONCE for the combined schema**

```bash
cd /root/my@chengchenccc/apps/backend && bunx drizzle-kit generate --config drizzle.backend.config.ts
```

This will generate migration SQL files in `apps/backend/drizzle/backend/`. **MANUALLY INSPECT** every generated SQL file:

- [ ] **Step 8.14a: B3 — Manual migration audit checklist**

Open each generated `.sql` file in `apps/backend/drizzle/backend/` and verify:

- [ ] No `DROP TABLE` for: `conversation_ledger`, `conversation`, `member`, `agents`, `issue`, `project`, `column_config`, `cron_job`, `deliverable`, `run`, `attempt`, `span_origin`, `surface_health`, `issue_event`, `control_plane_event`
- [ ] `DROP TABLE projection_messages` EXISTS (S2)
- [ ] `DROP TABLE runner_health` EXISTS (S3)
- [ ] `CREATE TABLE run/attempt/span_origin/control_plane_event/surface_health/issue_event` EXISTS (S1 — events 6 tables now in backend.db)
- [ ] For environments with existing data: the `control_plane_event` table is created via ALTER RENAME (S4), NOT drop+recreate

If drizzle generates a `DROP TABLE run_ops_event` + `CREATE TABLE control_plane_event` instead of `ALTER TABLE RENAME`, **DO NOT USE IT**. Replace with the hand-written ALTER from Step 7.4.

- [ ] **Step 8.15: Create the data migration script for existing environments**

Create `apps/backend/scripts/migrate-events-to-backend.sql`:

```sql
-- One-time script: copy events.db data into backend.db
-- Run AFTER backend.db has been migrated (tables created).
-- Usage: sqlite3 backend.db < scripts/migrate-events-to-backend.sql

ATTACH DATABASE '.backend-data/events.db' AS ev;

INSERT INTO run             SELECT * FROM ev.run;
INSERT INTO attempt         SELECT * FROM ev.attempt;
INSERT INTO control_plane_event SELECT * FROM ev.run_ops_event;
INSERT INTO span_origin     SELECT * FROM ev.run_origin;
INSERT INTO surface_health  SELECT * FROM ev.surface_health;
INSERT INTO issue_event     SELECT * FROM ev.issue_event;
-- runner_health intentionally not migrated (deleted in S3)

DETACH DATABASE ev;
```

- [ ] **Step 8.16: Smoke test — fresh start with empty DB**

```bash
cd /root/my@chengchenccc/apps/backend
rm -rf .backend-data
mkdir -p .backend-data
# Run gen-drizzle to create migration files
cd /root/my-agent-team && bash scripts/gen-drizzle.sh
# Start backend (depends on actual start command)
cd apps/backend && bun run dev &
sleep 3
# Verify startup logs show no errors
# Hit health endpoint
curl -s http://localhost:PORT/api/health || echo "Check actual port"
# Kill the process
kill %1
```

Expected: No SQLite errors, backend starts successfully with 2 DB files (backend.db + checkpointer.db).

- [ ] **Step 8.17: Smoke test — startup with existing data**

```bash
# If you have an events.db with real data:
cd /root/my@chengchenccc/apps/backend
# Run the migration script
sqlite3 .backend-data/backend.db < scripts/migrate-events-to-backend.sql
# Start backend
bun run dev &
sleep 3
# Verify /api/ops/sessions returns data
curl -s http://localhost:PORT/api/ops/sessions
kill %1
```

- [ ] **Step 8.18: Final verification grep**

```bash
cd /root/my-agent-team && grep -rn "events\.db\|events-db\|eventsDb\|runEventsDbMigrations\|events-schema\|drizzle\.events" --include="*.ts" --include="*.tsx" --include="*.sh" --include="*.json" apps/ packages/ scripts/
```
Expected: Zero matches (or only in the migration script and archived docs).

- [ ] **Step 8.19: Commit**

```bash
git add apps/backend/src/infra/db/schema.ts \
        apps/backend/src/main.ts \
        apps/backend/src/features/runtime-ops/store.ts \
        apps/backend/src/features/span/supervisor.ts \
        apps/backend/src/features/runtime-ops/store.test.ts \
        apps/backend/scripts/migrate-events-to-backend.sql \
        scripts/gen-drizzle.sh
git rm apps/backend/src/infra/db/events-schema.ts \
        apps/backend/src/features/span/events-db-migrations.ts \
        apps/backend/drizzle.events.config.ts
git commit -m "feat(S1): merge events.db into backend.db — 3 databases → 2

Storage convergence core: events.db (7 tables, all backend-package-owned)
merged into backend.db. The only remaining split is the legitimate package
boundary: checkpointer.db belongs to the framework package.

Changes:
- 6 events tables moved from events-schema.ts into schema.ts (runner_health dropped)
- RuntimeOpsStore and SpanSupervisor now use the single backend db connection
- events-db-migrations.ts deleted (schema now managed by drizzle/backend)
- drizzle.events.config.ts deleted
- gen-drizzle.sh: removed events generate step
- Test fixtures: runEventsDbMigrations → openDb
- Data migration script for existing environments included

Three databases → two: backend.db + checkpointer.db."
```

---

### Task 9: Final Integration Verification

- [ ] **Step 9.1: Run full typecheck**

```bash
cd /root/my-agent-team && bun run typecheck
```
Expected: zero errors.

- [ ] **Step 9.2: Run full test suite**

```bash
cd /root/my-agent-team && bun run test
```
Expected: all tests pass.

- [ ] **Step 9.3: Run lint**

```bash
cd /root/my-agent-team && bun run lint
```
Expected: zero errors (warnings OK).

- [ ] **Step 9.4: Final dead-reference grep**

```bash
cd /root/my-agent-team && \
  echo "=== projection_messages ===" && grep -rn "projection_messages\|projectionMessages" --include="*.ts" --include="*.tsx" apps/ packages/ && \
  echo "=== runner_health ===" && grep -rn "runner_health\|runnerHealth" --include="*.ts" --include="*.tsx" apps/ packages/ && \
  echo "=== events.db ===" && grep -rn "events\.db\|eventsDb\|events-db" --include="*.ts" --include="*.tsx" apps/ packages/ && \
  echo "=== run_ops_event (non-archive) ===" && grep -rn "run_ops_event\|runOpsEvent" --include="*.ts" --include="*.tsx" apps/ packages/ docs/architecture/ && \
  echo "=== events-schema ===" && grep -rn "events-schema" --include="*.ts" --include="*.tsx" apps/ packages/ && \
  echo "=== runEventsDbMigrations ===" && grep -rn "runEventsDbMigrations" --include="*.ts" --include="*.tsx" apps/ packages/
```
Expected output:
- `projection_messages`: zero matches
- `runner_health`: zero matches
- `events.db`: zero matches (or only in migration script)
- `run_ops_event`: only in the hand-written ALTER migration SQL and archived historical docs
- `events-schema`: zero matches
- `runEventsDbMigrations`: zero matches

- [ ] **Step 9.5: Push final branch**

```bash
git push origin feat/storage-convergence
```

- [ ] **Step 9.6: Mark acceptance checklist complete**

```markdown
## Acceptance Checklist

### Functional (B items — user-visible):
- [x] B0: Ops detail/Insights pages load without 500; readonly connection has no WAL PRAGMA
- [x] B1: Agent todo_update events land in conversation todo list; no longer silently dropped
- [x] B2: /ops/sessions aggregates by sessionId; /ops/sessions/:sessionId shows span list; span detail non-empty

### Storage Convergence (S items):
- [x] S1: events.db 6 tables merged into backend.db; 2 DB connections at runtime; events-db-migrations.ts + drizzle.events.config.ts deleted
- [x] S2: projection_messages table + orphan DELETE removed; grep returns zero
- [x] S3: runner_health table deleted; RunOpsEventKind narrowed to 3 values
- [x] S4: run_ops_event renamed to control_plane_event (hand-written ALTER + index rebuild); living docs updated; archived docs preserved

### Migration Safety (B3):
- [x] All generated migration SQL manually audited — no drop+recreate of data-holding tables
- [x] Data migration script uses INSERT...SELECT (not drop+recreate)
- [x] Fresh DB startup smoke test passed
- [x] Existing data startup smoke test passed
```

---

## Rollback Plan

If the migration fails in production:

1. **PR-1 (B0/B1/B2)**: Each fix is a single-line change, trivially revertible.
2. **PR-2 (S1/S2/S3/S4)**:
   - `projection_messages` and `runner_health` had no data — DROP is irreversible but harmless.
   - `control_plane_event` RENAME: reverse with `ALTER TABLE control_plane_event RENAME TO run_ops_event`.
   - events.db merge: the original `events.db` file is NOT deleted by the migration. If the merge goes wrong, revert the code and continue using the old two-file setup. The `events.db` file is untouched by the migration (only read from, not written to).

## Related Documents

- Spec: `docs/superpowers/specs/2026-06-27-storage-convergence.md`
- High-level plan: `docs/superpowers/plans/2026-06-27-storage-convergence-plan.md`
- Previous milestone: `docs/superpowers/specs/2026-06-27-observability-convergence.md`
- Architecture: `docs/architecture/foundations/facts-and-projections.md`, `docs/architecture/foundations/identifiers.md`, `docs/architecture/backend/event-log.md`
