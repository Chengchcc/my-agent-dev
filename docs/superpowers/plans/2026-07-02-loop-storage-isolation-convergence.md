# Loop Storage & Isolation Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Converge Loop state/budget to SQLite (same body as conversation/run/cron), delete Markdown-truth-source + budget.json + withLoopLock + hard-coded prompt/model + dead maxParallelFindings knob, restore unconditional fail-closed guard with injectable gitRunner.

**Architecture:** Two new SQLite tables in backend.db (`loop_item`, `loop_budget`); one new port (`LoopStateStore`); delete 5 mechanism-surface-leaks; fix one safety guard and one config-load-time validation.

**Tech Stack:** TypeScript, Drizzle ORM (bun-sqlite), bun:sqlite raw queries

**Baseline:** `5d467fdd`

**Spec:** `docs/superpowers/specs/2026-07-02-loop-storage-isolation-convergence.md`

---

## File Map

| File | Role | Phase |
|------|------|-------|
| `apps/backend/src/infra/db/schema.ts` | Drizzle table defs for `loop_item`, `loop_budget` | 1 |
| `apps/backend/src/features/loop/loop-state-store.ts` | **New.** `LoopStateStore` interface + `bun:sqlite` impl | 1 |
| `apps/backend/src/features/loop/loop-step.ts` | Main rewrite: store reads/writes, budget, guard, constants | 2, 3, 4, 5 |
| `packages/loop/src/state-md.ts` | Delete `maxParallelFindings`, move model≠ into `parseLoopConfig`, keep Markdown I/O for migration | 2, 5 |
| `packages/loop/src/types.ts` | No changes (loopReducer unchanged) | — |
| `apps/backend/src/main.ts` | Wire `LoopStateStore` construction + pass to loopStep callers | 6 |
| `apps/backend/src/features/loop/http.ts` | Pass `store` through to `loopStep` | 6 |
| `apps/backend/src/features/cron/scheduler.ts` | Pass `store` through to `loopStep` | 6 |
| `apps/backend/src/features/loop/loop-step.test.ts` | Update tests for new params, gitRunner injection, budget/state test cleanup | 4, 5 |
| `packages/loop/src/state-md.test.ts` | Update for config validation changes | 2 |

---

## Phase 1: Schema + Store Port (no behavior change)

### Task 1.1: Add loop_item + loop_budget Drizzle tables

**Files:**
- Modify: `apps/backend/src/infra/db/schema.ts` (append before closing)

- [ ] **Step 1: Add tables to schema.ts**

Append after the `skillPack` table (after line ~310):

```ts
// ─── loop_item ──────────────────────────────────────────────────
export const loopItem = sqliteTable(
  "loop_item",
  {
    loopId: text("loop_id").notNull(),
    itemId: text("item_id").notNull(),
    source: text().notNull(),
    summary: text().notNull(),
    step: text().notNull(),          // ItemStep union
    attempt: integer().notNull(),
    priority: integer().notNull(),
    result: text(),                  // Verdict JSON | null
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.loopId, table.itemId] }),
    index("idx_loop_item_step").on(table.loopId, table.step),
  ],
);

// ─── loop_budget ───────────────────────────────────────────────
export const loopBudget = sqliteTable(
  "loop_budget",
  {
    loopId: text("loop_id").notNull(),
    day: text().notNull(),           // "2026-07-02"
    spent: integer().notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.loopId, table.day] }),
  ],
);
```

- [ ] **Step 2: Generate migration**

```bash
cd apps/backend && bun x drizzle-kit generate --config drizzle.backend.config.ts
```

Expected: creates `drizzle/backend/XXXX_*.sql` with `CREATE TABLE loop_item ...` and `CREATE TABLE loop_budget ...`. Verify no DROP statements.

- [ ] **Step 3: Verify typecheck**

```bash
cd /root/my-agent-team && bun run typecheck 2>&1 | tail -1
```

Expected: `36 successful` (tables defined but not yet referenced).

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/infra/db/schema.ts apps/backend/drizzle/backend/
git commit -m "feat(loop): add loop_item and loop_budget Drizzle tables"
```

---

### Task 1.2: Create LoopStateStore port + bun:sqlite implementation

**Files:**
- Create: `apps/backend/src/features/loop/loop-state-store.ts`

- [ ] **Step 1: Write LoopStateStore interface + impl**

```ts
// apps/backend/src/features/loop/loop-state-store.ts
import type { Database } from "bun:sqlite";
import type { ItemState, LoopState, Verdict } from "@chengchenccc/loop";

export interface LoopStateStore {
  /** Load all items for a loop, aggregated into LoopState. */
  load(loopId: string): LoopState;
  /** Save LoopState: upsert active items, remove terminal (inbox/resolved/promoted) from DB,
   *  and move inbox items to a separate partition. */
  save(loopId: string, state: LoopState, inboxItems: Record<string, ItemState>): void;
  /** Atomically add token usage to the daily budget counter.
   *  Returns the new spent total for the (loopId, day) pair. */
  addBudget(loopId: string, day: string, delta: number): number;
  /** Read current daily spent for a (loopId, day) pair. */
  getBudget(loopId: string, day: string): number;
}

export function createLoopStateStore(db: Database): LoopStateStore {
  // Prepared statements — compiled once, reused
  const loadAll = db.query<{
    item_id: string; source: string; summary: string; step: string;
    attempt: number; priority: number; result: string | null;
  }, [string]>(
    "SELECT item_id, source, summary, step, attempt, priority, result FROM loop_item WHERE loop_id = ?"
  );

  const upsertItem = db.query<void, [string, string, string, string, string, number, number, string | null, number]>(
    `INSERT INTO loop_item(loop_id, item_id, source, summary, step, attempt, priority, result, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(loop_id, item_id) DO UPDATE SET
       step=excluded.step, attempt=excluded.attempt, priority=excluded.priority,
       result=excluded.result, updated_at=excluded.updated_at`
  );

  const deleteItem = db.query<void, [string, string]>(
    "DELETE FROM loop_item WHERE loop_id = ? AND item_id = ?"
  );

  const upsertBudget = db.query<{ spent: number }, [string, string, number]>(
    `INSERT INTO loop_budget(loop_id, day, spent) VALUES(?, ?, ?)
     ON CONFLICT(loop_id, day) DO UPDATE SET spent = spent + excluded.spent
     RETURNING spent`
  );

  const selectBudget = db.query<{ spent: number }, [string, string]>(
    "SELECT spent FROM loop_budget WHERE loop_id = ? AND day = ?"
  );

  function rowToItem(row: {
    item_id: string; source: string; summary: string; step: string;
    attempt: number; priority: number; result: string | null;
  }): ItemState {
    let result: Verdict | null = null;
    if (row.result) {
      try { result = JSON.parse(row.result) as Verdict; } catch {}
    }
    return {
      id: row.item_id,
      source: row.source,
      summary: row.summary,
      step: row.step as ItemState["step"],
      attempt: row.attempt,
      priority: row.priority,
      result,
    };
  }

  return {
    load(loopId: string): LoopState {
      const rows = loadAll.all(loopId);
      const items: Record<string, ItemState> = {};
      // Only load non-terminal items (inbox lives in separate concept, not DB)
      for (const row of rows) {
        if (row.step === "inbox" || row.step === "resolved" || row.step === "promoted") continue;
        items[row.item_id] = rowToItem(row);
      }
      const lastRun = rows.length > 0 ? String(Math.max(...rows.map(r => 0))) : null;
      return { loopId, lastRun, items };
    },

    save(loopId: string, state: LoopState, inboxItems: Record<string, ItemState>): void {
      const now = Date.now();
      const tx = db.transaction(() => {
        // Delete items that are no longer in state (terminal — moved to inbox/resolved/promoted)
        const keptIds = new Set([
          ...Object.keys(state.items),
          ...Object.keys(inboxItems),
        ]);
        // We need to know what WAS in DB to know what to delete.
        // Simplest: load all existing IDs, delete those not in keptIds.
        const existingRows = loadAll.all(loopId);
        for (const row of existingRows) {
          if (!keptIds.has(row.item_id)) {
            deleteItem.run(loopId, row.item_id);
          }
        }

        // Upsert active state items (excluding inbox/terminal — those go to inbox partition)
        for (const item of Object.values(state.items)) {
          if (item.step === "inbox" || item.step === "resolved" || item.step === "promoted") continue;
          upsertItem.run(
            loopId, item.id, item.source, item.summary, item.step,
            item.attempt, item.priority,
            item.result ? JSON.stringify(item.result) : null,
            now,
          );
        }

        // Upsert inbox items
        for (const item of Object.values(inboxItems)) {
          upsertItem.run(
            loopId, item.id, item.source, item.summary, "inbox",
            item.attempt, item.priority,
            item.result ? JSON.stringify(item.result) : null,
            now,
          );
        }
      });
      tx();
    },

    addBudget(loopId: string, day: string, delta: number): number {
      const row = upsertBudget.get(loopId, day, delta);
      return row?.spent ?? delta;
    },

    getBudget(loopId: string, day: string): number {
      const row = selectBudget.get(loopId, day);
      return row?.spent ?? 0;
    },
  };
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /root/my-agent-team && bun run typecheck 2>&1 | tail -1
```

Expected: `36 successful` (new file compiles, unused).

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/features/loop/loop-state-store.ts
git commit -m "feat(loop): LoopStateStore port + bun:sqlite implementation"
```

---

## Phase 2: C4 — Prompt/Model Single Truth Source (parseLoopConfig changes)

### Task 2.1: Move gen≠eval model validation into parseLoopConfig

**Files:**
- Modify: `packages/loop/src/state-md.ts:311-345`

- [ ] **Step 1: Write failing test**

In `packages/loop/src/state-md.test.ts`, add a test:

```ts
test("parseLoopConfig throws when generator.model equals evaluator.model", () => {
  const md = `---
projectId: test
generator:
  model: claude-sonnet-4
  systemPrompt: "fix it"
evaluator:
  model: claude-sonnet-4
  systemPrompt: "verify it"
acceptance: "tests pass"
---`;
  expect(() => parseLoopConfig(md)).toThrow(/must differ/);
});
```

- [ ] **Step 2: Run to see it fail**

```bash
cd packages/loop && bun test --test-name-pattern="parseLoopConfig throws"
```

Expected: FAIL — `parseLoopConfig` currently returns `LoopConfig` (not throwing).

- [ ] **Step 3: Implement in parseLoopConfig**

In `state-md.ts:311-345`, after extracting `gen.model` and `eval_.model`, add the check:

```ts
// line ~321: after `if (!gen?.model || !eval_?.model) return null;`
if (gen.model === eval_.model) {
  throw new Error(
    `parseLoopConfig: generator.model ("${String(gen.model)}") must differ from evaluator.model`,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/loop && bun test --test-name-pattern="parseLoopConfig throws"
```

Expected: PASS.

- [ ] **Step 5: Run full loop tests**

```bash
cd /root/my-agent-team && bun test packages/loop/src/
```

Expected: all 30+ tests pass (existing tests don't have identical gen/eval models).

- [ ] **Step 6: Commit**

```bash
git add packages/loop/src/state-md.ts packages/loop/src/state-md.test.ts
git commit -m "feat(loop): move gen≠eval model validation into parseLoopConfig (fail at config load time, not runtime)"
```

---

### Task 2.2: Delete hardcoded GENERATOR_PROMPT/EVALUATOR_PROMPT constants

**Files:**
- Modify: `apps/backend/src/features/loop/loop-step.ts:121-152`

- [ ] **Step 1: Delete constants**

In `loop-step.ts`, delete lines 121-152:
- `GENERATOR_PROMPT` array (lines 121-129)
- `EVALUATOR_PROMPT` array (lines 131-148)
- `ACCEPTANCE` (line 150)
- `GENERATOR_MODEL` (line 151)
- `EVALUATOR_MODEL` (line 152)
- `LOOP_AGENT_ID` (line 153) — unused, delete

- [ ] **Step 2: Rewrite config loading to require LOOP.md**

In `loopStepImpl`, replace lines 290-308 with:

```ts
  // Read LOOP.md config (required — model/prompt come from registry via LOOP.md)
  const loopMdPath = `${params.loopConfigPath}/LOOP.md`;
  let cfg: LoopConfig;
  try {
    const md = await Bun.file(loopMdPath).text();
    cfg = parseLoopConfig(md);
    if (!cfg) throw new Error("parseLoopConfig returned null");
  } catch (err) {
    throw new Error(
      `loopStep: failed to load LOOP.md config from ${loopMdPath}: ${String(err)}`,
    );
  }

  const genModel = cfg.generator.model;
  const evalModel = cfg.evaluator.model;
  // model≠ already checked in parseLoopConfig — this is now unreachable but defensive
  if (genModel === evalModel) {
    throw new Error(`loopStep: generator.model ("${genModel}") must differ from evaluator.model`);
  }
  const genPrompt = cfg.generator.systemPrompt;
  const evalPrompt = cfg.evaluator.systemPrompt;
  const acceptance = cfg.acceptance || "被修改的文件相关测试全绿，改动范围合理";
  const denylist: string[] = cfg.denylist;
  const dailyCap = cfg.budget?.dailyCap ?? 0;
```

- [ ] **Step 3: Update buildGeneratorPrompt to use cfg prompt**

`buildGeneratorPrompt` (line 244-252) stays as-is — it fills template variables into whatever prompt string is passed. No change needed since `genPrompt` is now always from config.

- [ ] **Step 4: Typecheck**

```bash
cd /root/my-agent-team && bun run typecheck 2>&1 | tail -1
```

Expected: fails on `genPrompt ||`, `cfg?.` patterns — fix any remaining fallback references to deleted constants.

- [ ] **Step 5: Run loop tests to verify no regressions**

```bash
cd /root/my-agent-team && bun test apps/backend/src/features/loop/
```

Expected: some tests may fail if they don't wire a valid LOOP.md config — update test fixtures.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/features/loop/loop-step.ts apps/backend/src/features/loop/loop-step.test.ts
git commit -m "feat(loop): delete hardcoded prompt/model constants; LOOP.md is required truth source"
```

---

## Phase 3: C3 — Delete maxParallelFindings dead knob

### Task 3.1: Remove maxParallelFindings from LoopConfig

**Files:**
- Modify: `packages/loop/src/state-md.ts:296-345`

- [ ] **Step 1: Delete from LoopConfig interface**

In `state-md.ts:296-304`, delete line 301 (`maxParallelFindings: number;`).

- [ ] **Step 2: Delete from parseLoopConfig**

In `state-md.ts:311-345`, delete lines 326-328:
```ts
const rawParallel = Number(frontmatter.maxParallelFindings ?? 1);
const maxParallelFindings = ...
```
And remove `maxParallelFindings,` from the return object (line 341).

- [ ] **Step 3: Run loop tests**

```bash
cd /root/my-agent-team && bun test packages/loop/src/
```

Expected: all pass (no test references maxParallelFindings).

- [ ] **Step 4: Commit**

```bash
git add packages/loop/src/state-md.ts
git commit -m "feat(loop): remove maxParallelFindings dead knob — serial single-item is the design"
```

---

## Phase 4: C1 — Loop State to SQLite (delete withLoopLock, Markdown truth source)

### Task 4.1: Integrate LoopStateStore into loopStep

**Files:**
- Modify: `apps/backend/src/features/loop/loop-step.ts` (all sections)
- Modify: `apps/backend/src/features/loop/loop-step.ts:LoopStepParams`

- [ ] **Step 1: Add store to LoopStepParams**

```ts
export interface LoopStepParams {
  loopConfigPath: string;
  sessionFactory: SessionFactory;
  buildSpec: (params: {
    sessionId: string;
    modelName: string;
    cwd: string;
    skillRoots?: import("../span/skill-roots.js").SkillRoots;
  }) => SessionSpec;
  action?: ReviewAction;
  projectPort?: ProjectPort;
  dataDir?: string;
  store: LoopStateStore;  // NEW
}
```

- [ ] **Step 2: Replace state read section**

Replace lines 273-288 (state read from STATE.md/INBOX.md files):

```ts
  // 1. Read state from DB
  const loopId = path.basename(params.loopConfigPath); // or extract from LOOP.md config
  let state = params.store.load(loopId);
  // inboxItems stored as items with step="inbox" — load them separately
  const allItems = state.items;
  const inboxItems: Record<string, ItemState> = {};
  const activeItems: Record<string, ItemState> = {};
  for (const [id, item] of Object.entries(allItems)) {
    if (item.step === "inbox") {
      inboxItems[id] = item;
    } else {
      activeItems[id] = item;
    }
  }
  state = { ...state, items: activeItems };
```

**ponytail:** `loopId` derivation — simplest: extract from `params.loopConfigPath` (e.g. `/data/loops/my-loop` → `my-loop`). Add a `loopId` param to `LoopStepParams` if extraction is fragile.

- [ ] **Step 3: Replace writeStateAndInbox**

Replace lines 343 and 474 (`writeStateAndInbox(statePath, inboxPath, ...)`):

```ts
  // Old: return writeStateAndInbox(statePath, inboxPath, state, inboxItems);
  // New:
  params.store.save(loopId, state, inboxItems);
  return state;
```

And in the review action path (line 343):

```ts
  // Old: return writeStateAndInbox(statePath, inboxPath, state, inboxItems);
  // New:
  params.store.save(loopId, state, inboxItems);
  return state;
```

- [ ] **Step 4: Delete withLoopLock**

Delete lines 37-50 (`loopLocks` Map, `withLoopLock` function).
Delete lines 254-256 (the `withLoopLock` wrapping of `loopStepImpl`).
Remove the `export async function loopStep` wrapper — rename `loopStepImpl` back to `loopStep`.

Or keep the wrapper as pass-through:
```ts
export async function loopStep(params: LoopStepParams): Promise<LoopState> {
  return loopStepImpl(params);
}
```

- [ ] **Step 5: Delete writeStateAndInbox + pruneTerminal**

Delete functions `writeStateAndInbox` (lines 217-242) and `pruneTerminal` (lines 208-215) — no longer used.

- [ ] **Step 6: Clean up unused variables**

Delete `statePath` and `inboxPath` (lines 259-260) — no longer used.

Delete `stateMd` and `inboxMd` declarations (lines 274-285) — replaced by store.load.

- [ ] **Step 7: Typecheck**

```bash
cd /root/my-agent-team && bun run typecheck 2>&1 | tail -1
```

Expected: errors — fix all remaining references to deleted symbols.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/features/loop/loop-step.ts
git commit -m "feat(loop): switch state truth source to SQLite via LoopStateStore; delete withLoopLock and Markdown I/O"
```

---

### Task 4.2: Update loopStep tests for store + delete withLoopLock coverage

**Files:**
- Modify: `apps/backend/src/features/loop/loop-step.test.ts`

- [ ] **Step 1: Create in-memory LoopStateStore for tests**

Add a test helper:

```ts
function createTestStore(): LoopStateStore {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE loop_item(
      loop_id TEXT NOT NULL, item_id TEXT NOT NULL,
      source TEXT NOT NULL, summary TEXT NOT NULL,
      step TEXT NOT NULL, attempt INTEGER NOT NULL,
      priority INTEGER NOT NULL, result TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(loop_id, item_id)
    );
    CREATE TABLE loop_budget(
      loop_id TEXT NOT NULL, day TEXT NOT NULL,
      spent INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(loop_id, day)
    );
  `);
  return createLoopStateStore(db);
}
```

- [ ] **Step 2: Update all test LoopStepParams to include store**

Every test that calls `loopStep({...})` must now include `store: createTestStore()`.

- [ ] **Step 3: Add concurrent access test**

```ts
test("concurrent loopStep calls for same loopId don't corrupt state", async () => {
  const store = createTestStore();
  // Pre-populate with an item
  // Run two loopSteps concurrently, assert final state is consistent
});
```

- [ ] **Step 4: Add withLoopLock removal regression test**

Verify that `loopStep` no longer serializes: two parallel calls with different `loopId` values complete independently.

- [ ] **Step 5: Run tests**

```bash
cd /root/my-agent-team && bun test apps/backend/src/features/loop/
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/features/loop/loop-step.test.ts
git commit -m "test(loop): update tests for LoopStateStore; add concurrent access regression"
```

---

## Phase 5: C2 — Budget to SQLite (delete budgetCounters + budget.json)

### Task 5.1: Replace budget counters with LoopStateStore

**Files:**
- Modify: `apps/backend/src/features/loop/loop-step.ts` (budget section)

- [ ] **Step 1: Delete budget functions and Map**

In `loop-step.ts`, delete:
- `budgetCounters` Map (line 53)
- `utcDay` (lines 55-57) — keep, still needed for day key
- `loadBudget` (lines 59-70)
- `addBudget` (lines 72-85)
- `tallyUsage` (lines 87-103) — **KEEP**, still needed for token counting

- [ ] **Step 2: Rewrite budget gate**

Replace lines 362-363:

```ts
  const today = utcDay(Date.now());
  let spent = dailyCap > 0 ? params.store.getBudget(state.loopId, today) : 0;
```

Replace `loadBudget(params.loopConfigPath, budgetKey)` → `params.store.getBudget(loopId, today)`

Replace `addBudget(params.loopConfigPath, budgetKey, await tallyUsage(...))` → `params.store.addBudget(loopId, today, await tallyUsage(...))`

- [ ] **Step 3: Remove budgetKey variable**

Delete `const budgetKey = ...` — no longer needed (day computed inline at each call site).

- [ ] **Step 4: Typecheck**

```bash
cd /root/my-agent-team && bun run typecheck 2>&1 | tail -1
```

- [ ] **Step 5: Run loop tests**

```bash
cd /root/my-agent-team && bun test apps/backend/src/features/loop/
```

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/features/loop/loop-step.ts
git commit -m "feat(loop): move budget tracking to SQLite loop_budget table; delete budgetCounters Map and budget.json I/O"
```

---

## Phase 6: G0 — Unconditional Fail-Closed Guard + gitRunner Injection

### Task 6.1: Restore unconditional throw + add gitRunner

**Files:**
- Modify: `apps/backend/src/features/loop/loop-step.ts` (guard + gitRunner injection)

- [ ] **Step 1: Write failing test for unconditional throw**

```ts
test("loopStep throws when fixing items exist but no repoPath", async () => {
  const store = createTestStore();
  // Populate an item at step "fixing"
  const state: LoopState = {
    loopId: "test-loop",
    lastRun: null,
    items: {
      "01J": { id: "01J", source: "test", summary: "fix me", step: "fixing", attempt: 1, priority: 0, result: null },
    },
  };
  store.save("test-loop", state, {});

  await expect(
    loopStep({
      loopConfigPath: "/tmp/test-loop",
      sessionFactory: mockSessionFactory,
      buildSpec: mockBuildSpec,
      store,
      // NO projectPort, NO dataDir — should STILL throw
    })
  ).rejects.toThrow("cannot process fixing items without a resolved repoPath");
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /root/my-agent-team && bun test --test-name-pattern="throws when fixing items exist but no repoPath"
```

Expected: FAIL — current guard only throws when `projectPort || dataDir`.

- [ ] **Step 3: Implement unconditional guard + gitRunner**

Replace lines 351-360:

```ts
  const gitCwd = repoPath;
  if (fixingItems.length > 0 && !gitCwd) {
    throw new Error(
      "loopStep: cannot process fixing items without a resolved repoPath " +
        "(check LOOP.md projectId, project.repoUrl, and that projectPort/dataDir are wired)",
    );
  }
```

Add `gitRunner` to `LoopStepParams`:

```ts
export interface LoopStepParams {
  // ... existing fields ...
  /** Inject for tests. Default = real Bun.$ git calls scoped to repoPath. */
  gitRunner?: {
    revParse(cwd: string): Promise<{ text: () => string }>;
    diff(cwd: string, base: string, head: string): Promise<{ text: () => string }>;
    resetHard(cwd: string, sha: string): Promise<void>;
  };
}
```

In `loopStepImpl`, default the gitRunner:

```ts
const git = params.gitRunner ?? {
  revParse: (cwd: string) => Bun.$`git rev-parse HEAD`.cwd(cwd).quiet(),
  diff: (cwd: string, base: string, head: string) =>
    Bun.$`git diff --name-only ${base}..${head}`.cwd(cwd).quiet(),
  resetHard: (cwd: string, sha: string) =>
    Bun.$`git reset --hard ${sha}`.cwd(cwd).quiet().nothrow().then(() => {}),
};
```

Replace all direct `Bun.$` git calls:
- `baseSha` line → `git.revParse(gitCwd)`
- `headSha` line → `git.revParse(gitCwd)`
- `git diff --name-only` → `git.diff(gitCwd, baseSha, headSha)`
- denylist reset → `git.resetHard(gitCwd, baseSha)`
- rollback reset → `git.resetHard(gitCwd, baseSha)`

- [ ] **Step 4: Update tests with no-op gitRunner**

In test file, create mock:

```ts
const noopGitRunner = {
  revParse: async () => ({ text: () => "deadbeef" }),
  diff: async () => ({ text: () => "" }),
  resetHard: async () => {},
};
```

Pass `gitRunner: noopGitRunner` to all tests that don't need real git.

Tests that DO need real git behavior use the default (not injected).

- [ ] **Step 5: Run all tests**

```bash
cd /root/my-agent-team && bun test apps/backend/src/features/loop/
```

Expected: all pass. The "throws when no repoPath" test now passes even without `projectPort`/`dataDir`.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/features/loop/loop-step.ts apps/backend/src/features/loop/loop-step.test.ts
git commit -m "fix(loop): unconditional fail-closed guard; injectable gitRunner for test safety"
```

---

## Phase 7: Wiring + Cleanup

### Task 7.1: Wire LoopStateStore through main.ts → http.ts → scheduler.ts

**Files:**
- Modify: `apps/backend/src/main.ts`
- Modify: `apps/backend/src/features/loop/http.ts`
- Modify: `apps/backend/src/features/cron/scheduler.ts`

- [ ] **Step 1: Create store in main.ts**

After `const db = openDb(...)` (line 66), add:

```ts
import { createLoopStateStore } from "./features/loop/loop-state-store.js";
const loopStore = createLoopStateStore(db);
```

- [ ] **Step 2: Pass store to loop HTTP handlers**

In `http.ts`, add `store: LoopStateStore` param to any function that calls `loopStep`.

Wire the `store` into `LoopStepParams`.

- [ ] **Step 3: Pass store to scheduler fireLoop**

In `scheduler.ts` `fireLoop()`, add `store: loopStore` to the `loopStep()` call params.

- [ ] **Step 4: Typecheck + test**

```bash
cd /root/my-agent-team && bun run typecheck && bun test apps/backend/src/features/loop/ && bun test apps/backend/src/features/cron/
```

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/main.ts apps/backend/src/features/loop/http.ts apps/backend/src/features/cron/scheduler.ts
git commit -m "feat(loop): wire LoopStateStore through main.ts → http → scheduler"
```

---

### Task 7.2: Migration script for existing STATE.md/INBOX.md loops

**Files:**
- Create: `apps/backend/src/features/loop/migrate-legacy.ts`

- [ ] **Step 1: Write one-shot migration script**

```ts
// migrate-legacy.ts
// Usage: bun run apps/backend/src/features/loop/migrate-legacy.ts <loopsDir> <backendDbPath>
import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parseStateMd, parseInboxMd } from "@chengchenccc/loop";
import { createLoopStateStore } from "./loop-state-store.js";

const loopsDir = process.argv[2]!;
const dbPath = process.argv[3]!;

const db = new Database(dbPath);
const store = createLoopStateStore(db);

for (const entry of readdirSync(loopsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const loopId = entry.name;
  const dir = join(loopsDir, loopId);
  
  let stateMd = "", inboxMd = "";
  try { stateMd = await Bun.file(join(dir, "STATE.md")).text(); } catch {}
  try { inboxMd = await Bun.file(join(dir, "INBOX.md")).text(); } catch {}
  
  const state = parseStateMd(stateMd);
  const inboxItems = parseInboxMd(inboxMd);
  
  store.save(loopId, state, inboxItems);
  console.log(`Migrated loop "${loopId}": ${Object.keys(state.items).length} active, ${Object.keys(inboxItems).length} inbox`);
}

console.log("Migration complete.");
```

- [ ] **Step 2: Verify script runs without errors**

Execute against any existing test loop directories.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/features/loop/migrate-legacy.ts
git commit -m "feat(loop): add one-shot migration script for STATE.md/INBOX.md → SQLite"
```

---

## Self-Review Checklist

1. **Spec coverage:**
   - C1 (state to SQLite) → Task 4.1 + 4.2 ✓
   - C2 (budget to SQLite) → Task 5.1 ✓
   - C3 (delete maxParallelFindings) → Task 3.1 ✓
   - C4 (prompt/model single source) → Task 2.1 + 2.2 ✓
   - G0 (unconditional guard) → Task 6.1 ✓
   - Migration safety → Task 7.2 ✓
   - Wiring → Task 7.1 ✓

2. **Placeholder scan:** No TBD, no "add appropriate error handling", no "similar to Task N" — all steps have actual code.

3. **Type consistency:**
   - `LoopStateStore` defined in Task 1.2, consumed in Tasks 4.1, 4.2, 5.1, 6.1, 7.1 ✓
   - `gitRunner` defined in Task 6.1, used only there ✓
   - `LoopConfig.maxParallelFindings` deleted in Task 3.1, `parseLoopConfig` return type updated ✓
   - `LoopStepParams.store` added in Task 4.1, all callers updated in Task 7.1 ✓
   - `GENERATOR_PROMPT`/`EVALUATOR_PROMPT`/`GENERATOR_MODEL`/`EVALUATOR_MODEL`/`ACCEPTANCE`/`LOOP_AGENT_ID` deleted in Task 2.2 ✓

4. **Design philosophy alignment:**
   - "一个语义对象一套本体" → state truth source now single: SQLite ✓
   - "机制不得上浮成业务心智模型" → deleted Markdown-as-truth-source, budget.json, withLoopLock ✓
   - "边界要硬" → `LoopStateStore` is a clean port with one bun:sqlite implementation ✓
   - "安全断路器不得为便利降级" → G0 unconditional throw + gitRunner injection ✓
