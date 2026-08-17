# M1 loopReducer — 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 建 `packages/loop/` 新包，落地 `loopReducer(state, action, opts?) → state` 纯函数 + 全量单测。

**Architecture:** 纯 TypeScript 类型 + 纯函数。无依赖（不 import 任何 `@chengchenccc/*` 包）。L4 级（与 harness 同级），但只含类型和纯逻辑——不调 AgentSession、不读文件、不碰网络。

**Tech Stack:** TypeScript, bun:test

**Reference:** `docs/superpowers/specs/2026-07-01-m1-loop-reducer.md`

---

### Task 1: 建包骨架

**Files:**
- Create: `packages/loop/package.json`
- Create: `packages/loop/tsconfig.json`
- Create: `packages/loop/tsconfig.test.json`
- Create: `packages/loop/src/index.ts`

- [ ] **Step 1.1: Create `packages/loop/package.json`**

```json
{
  "name": "@chengchenccc/loop-engine",
  "version": "0.1.0",
  "type": "module",
  "main": "./src/index.ts",
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "lint": "biome check src/"
  },
  "devDependencies": {
    "@types/bun": "latest"
  }
}
```

- [ ] **Step 1.2: Create `packages/loop/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src"]
}
```

- [ ] **Step 1.3: Create `packages/loop/tsconfig.test.json`**

```json
{
  "extends": "./tsconfig.json",
  "include": ["src", "src/**/*.test.ts"]
}
```

- [ ] **Step 1.4: Create `packages/loop/src/index.ts`**

```typescript
export type {
  ItemId,
  ItemStep,
  Verdict,
  ItemState,
  LoopState,
  LoopAction,
} from "./types.js";
export { loopReducer } from "./loop-reducer.js";
```

- [ ] **Step 1.5: Install deps**

```bash
cd packages/loop && bun install
```

- [ ] **Step 1.6: Commit**

```bash
git add packages/loop && git commit -m "feat(loop-engine): scaffold package skeleton"
```

---

### Task 2: 类型定义

**Files:**
- Create: `packages/loop/src/types.ts`

- [ ] **Step 2.1: Write `types.ts`**

```typescript
// === Item identity ===
export type ItemId = string; // ULID, e.g. "01JN7X8K3M..."

// === Item step ===
export type ItemStep =
  | "triaged"
  | "fixing"
  | "verifying"
  | "awaiting_review"
  | "resolved"
  | "inbox"
  | "promoted";

// === Evaluator verdict ===
export type Verdict =
  | { verdict: "PASS"; evidence: string }
  | { verdict: "REJECT"; reasons: string[]; evidence: string }
  | { verdict: "ESCALATE"; reasons: string[]; evidence: string };

// === Single item ===
export type ItemState = {
  id: ItemId;
  source: string;
  summary: string;
  step: ItemStep;
  attempt: number;
  priority: number;
  result: Verdict | null;
};

// === Loop state ===
export type LoopState = {
  loopId: string;
  lastRun: string | null;
  items: Record<ItemId, ItemState>;
};

// === Actions ===
export type LoopAction =
  | { type: "TICK" }
  | { type: "GENERATOR_DONE"; itemId: ItemId }
  | { type: "EVALUATOR_VERDICT"; itemId: ItemId; verdict: Verdict }
  | { type: "APPROVE"; itemId: ItemId }
  | { type: "REJECT_HUMAN"; itemId: ItemId; feedback?: string }
  | { type: "PROMOTE"; itemId: ItemId }
  | { type: "RETRY"; itemId: ItemId }
  | { type: "DISMISS"; itemId: ItemId }
  | { type: "ADD_ITEM"; item: Omit<ItemState, "step" | "attempt" | "priority" | "result">; priority?: number };
```

- [ ] **Step 2.2: Verify typecheck**

```bash
cd packages/loop && bun run typecheck
```

- [ ] **Step 2.3: Commit**

```bash
git add packages/loop/src/types.ts && git commit -m "feat(loop-engine): define LoopState, LoopAction types"
```

---

### Task 3: 实现 loopReducer

**Files:**
- Create: `packages/loop/src/loop-reducer.ts`

- [ ] **Step 3.1: Write `loop-reducer.ts`**

```typescript
import type { LoopState, LoopAction, ItemState } from "./types.js";

type ReducerOpts = {
  maxRetries?: number;
  autoResolve?: boolean;
};

const DEFAULT_MAX_RETRIES = 3;

function cloneItems(items: LoopState["items"]): LoopState["items"] {
  return { ...items };
}

function getItem(state: LoopState, itemId: string): ItemState | undefined {
  return state.items[itemId];
}

function isEvidenceEmpty(evidence: string): boolean {
  return evidence.trim().length === 0;
}

export function loopReducer(
  state: LoopState,
  action: LoopAction,
  opts?: ReducerOpts,
): LoopState {
  const maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const autoResolve = opts?.autoResolve ?? false;
  const items = cloneItems(state.items);

  switch (action.type) {
    // --- TICK: all triaged → fixing ---
    case "TICK": {
      for (const id of Object.keys(items)) {
        const item = items[id]!;
        if (item.step === "triaged") {
          items[id] = { ...item, step: "fixing" };
        }
      }
      break;
    }

    // --- GENERATOR_DONE: fixing → verifying, clear result ---
    case "GENERATOR_DONE": {
      const item = items[action.itemId];
      if (item && item.step === "fixing") {
        items[action.itemId] = { ...item, step: "verifying", result: null };
      }
      break;
    }

    // --- EVALUATOR_VERDICT ---
    case "EVALUATOR_VERDICT": {
      const item = items[action.itemId];
      if (!item || item.step !== "verifying") break;

      const { verdict } = action;

      if (verdict.verdict === "PASS") {
        if (isEvidenceEmpty(verdict.evidence)) break; // no evidence → no transfer
        items[action.itemId] = {
          ...item,
          step: autoResolve ? "resolved" : "awaiting_review",
          result: verdict,
        };
      } else if (verdict.verdict === "REJECT") {
        if (item.attempt >= maxRetries) {
          items[action.itemId] = {
            ...item,
            step: "inbox",
            result: verdict,
          };
        } else {
          items[action.itemId] = {
            ...item,
            step: "fixing",
            attempt: item.attempt + 1,
            result: verdict,
          };
        }
      } else {
        // ESCALATE
        items[action.itemId] = {
          ...item,
          step: "inbox",
          result: verdict,
        };
      }
      break;
    }

    // --- APPROVE: awaiting_review → resolved ---
    case "APPROVE": {
      const item = items[action.itemId];
      if (item && item.step === "awaiting_review") {
        items[action.itemId] = { ...item, step: "resolved" };
      }
      break;
    }

    // --- REJECT_HUMAN: awaiting_review → inbox ---
    case "REJECT_HUMAN": {
      const item = items[action.itemId];
      if (item && item.step === "awaiting_review") {
        items[action.itemId] = {
          ...item,
          step: "inbox",
          result: {
            verdict: "REJECT",
            reasons: [action.feedback ?? "手动驳回"],
            evidence: "",
          },
        };
      }
      break;
    }

    // --- PROMOTE: awaiting_review → promoted ---
    case "PROMOTE": {
      const item = items[action.itemId];
      if (item && item.step === "awaiting_review") {
        items[action.itemId] = { ...item, step: "promoted" };
      }
      break;
    }

    // --- RETRY: inbox → triaged ---
    case "RETRY": {
      const item = items[action.itemId];
      if (item && item.step === "inbox") {
        items[action.itemId] = {
          ...item,
          step: "triaged",
          attempt: 1,
          result: null,
        };
      }
      break;
    }

    // --- DISMISS: inbox → remove ---
    case "DISMISS": {
      const item = items[action.itemId];
      if (item && item.step === "inbox") {
        delete items[action.itemId];
      }
      break;
    }

    // --- ADD_ITEM: add new, reject conflict ---
    case "ADD_ITEM": {
      const newId = action.item.id;
      if (items[newId]) break; // conflict → no-op
      items[newId] = {
        ...action.item,
        step: "triaged",
        attempt: 1,
        priority: action.priority ?? 0,
        result: null,
      };
      break;
    }
  }

  return { ...state, items };
}
```

**Key invariants in implementation:**
- `getItem` returns `undefined` for unknown itemId → no-op, return cloned state
- `delete items[id]` is the only mutation — DISMISS only
- `!items[action.itemId]` guard before every step-check
- Evidence emptiness checked via `.trim().length === 0` — catches `""`, `" "`, `"\n"`

- [ ] **Step 3.2: Verify typecheck**

```bash
cd packages/loop && bun run typecheck
```

- [ ] **Step 3.3: Commit**

```bash
git add packages/loop/src/loop-reducer.ts && git commit -m "feat(loop-engine): implement loopReducer pure function"
```

---

### Task 4: 全量单测

**Files:**
- Create: `packages/loop/src/loop-reducer.test.ts`

**Coverage required (17 acceptance criteria from spec §7):**

- [ ] **Step 4.1: TICK tests**

```typescript
import { describe, test, expect } from "bun:test";
import { loopReducer } from "./loop-reducer.js";
import type { LoopState } from "./types.js";

function emptyState(): LoopState {
  return { loopId: "test", lastRun: null, items: {} };
}

function stateWith(items: LoopState["items"]): LoopState {
  return { loopId: "test", lastRun: null, items: { ...items } };
}

describe("loopReducer — TICK", () => {
  test("triaged → fixing (all)", () => {
    const s = stateWith({
      "01": { id: "01", source: "ci", summary: "a", step: "triaged", attempt: 1, priority: 0, result: null },
      "02": { id: "02", source: "ci", summary: "b", step: "triaged", attempt: 1, priority: 0, result: null },
    });
    const next = loopReducer(s, { type: "TICK" });
    expect(next.items["01"]!.step).toBe("fixing");
    expect(next.items["02"]!.step).toBe("fixing");
  });

  test("non-triaged items unchanged", () => {
    const s = stateWith({
      "01": { id: "01", source: "ci", summary: "a", step: "fixing", attempt: 1, priority: 0, result: null },
      "02": { id: "02", source: "ci", summary: "b", step: "awaiting_review", attempt: 1, priority: 0, result: null },
    });
    const next = loopReducer(s, { type: "TICK" });
    expect(next.items["01"]!.step).toBe("fixing");
    expect(next.items["02"]!.step).toBe("awaiting_review");
  });

  test("empty state unchanged", () => {
    const s = emptyState();
    const next = loopReducer(s, { type: "TICK" });
    expect(next.items).toEqual({});
  });

  test("immutability: original state not modified", () => {
    const s = stateWith({
      "01": { id: "01", source: "ci", summary: "a", step: "triaged", attempt: 1, priority: 0, result: null },
    });
    loopReducer(s, { type: "TICK" });
    expect(s.items["01"]!.step).toBe("triaged"); // original unchanged
  });
});
```

- [ ] **Step 4.2: GENERATOR_DONE tests**

```typescript
describe("loopReducer — GENERATOR_DONE", () => {
  test("fixing → verifying, result cleared", () => {
    const s = stateWith({
      "01": { id: "01", source: "ci", summary: "a", step: "fixing", attempt: 1, priority: 0, result: { verdict: "REJECT", reasons: ["old"], evidence: "x" } as const },
    });
    const next = loopReducer(s, { type: "GENERATOR_DONE", itemId: "01" });
    expect(next.items["01"]!.step).toBe("verifying");
    expect(next.items["01"]!.result).toBeNull();
  });

  test("non-fixing item unchanged", () => {
    const s = stateWith({
      "01": { id: "01", source: "ci", summary: "a", step: "triaged", attempt: 1, priority: 0, result: null },
    });
    const next = loopReducer(s, { type: "GENERATOR_DONE", itemId: "01" });
    expect(next.items["01"]!.step).toBe("triaged");
  });

  test("unknown itemId → no-op", () => {
    const s = emptyState();
    const next = loopReducer(s, { type: "GENERATOR_DONE", itemId: "nope" });
    expect(next).toEqual(s);
  });
});
```

- [ ] **Step 4.3: EVALUATOR_VERDICT tests**

```typescript
describe("loopReducer — EVALUATOR_VERDICT", () => {
  const verifyingItem = {
    id: "01", source: "ci", summary: "a", step: "verifying" as const, attempt: 1, priority: 0, result: null,
  };

  test("PASS → awaiting_review (L2 default)", () => {
    const s = stateWith({ "01": verifyingItem });
    const next = loopReducer(s, { type: "EVALUATOR_VERDICT", itemId: "01", verdict: { verdict: "PASS", evidence: "12/12 green" } });
    expect(next.items["01"]!.step).toBe("awaiting_review");
  });

  test("PASS → resolved (L3 autoResolve)", () => {
    const s = stateWith({ "01": verifyingItem });
    const next = loopReducer(s, { type: "EVALUATOR_VERDICT", itemId: "01", verdict: { verdict: "PASS", evidence: "12/12 green" } }, { autoResolve: true });
    expect(next.items["01"]!.step).toBe("resolved");
  });

  test("PASS with empty evidence → no-op", () => {
    const s = stateWith({ "01": verifyingItem });
    const next = loopReducer(s, { type: "EVALUATOR_VERDICT", itemId: "01", verdict: { verdict: "PASS", evidence: "" } });
    expect(next.items["01"]!.step).toBe("verifying");
  });

  test("PASS with whitespace-only evidence → no-op", () => {
    const s = stateWith({ "01": verifyingItem });
    const next = loopReducer(s, { type: "EVALUATOR_VERDICT", itemId: "01", verdict: { verdict: "PASS", evidence: "   " } });
    expect(next.items["01"]!.step).toBe("verifying");
  });

  test("REJECT → fixing (attempt < maxRetries)", () => {
    const s = stateWith({ "01": verifyingItem });
    const next = loopReducer(s, { type: "EVALUATOR_VERDICT", itemId: "01", verdict: { verdict: "REJECT", reasons: ["scope drift"], evidence: "x" } });
    expect(next.items["01"]!.step).toBe("fixing");
    expect(next.items["01"]!.attempt).toBe(2);
  });

  test("REJECT → inbox (attempt >= maxRetries)", () => {
    const s = stateWith({
      "01": { ...verifyingItem, attempt: 3 },
    });
    const next = loopReducer(s, { type: "EVALUATOR_VERDICT", itemId: "01", verdict: { verdict: "REJECT", reasons: ["scope drift"], evidence: "x" } });
    expect(next.items["01"]!.step).toBe("inbox");
  });

  test("REJECT with custom maxRetries", () => {
    const s = stateWith({ "01": { ...verifyingItem, attempt: 2 } });
    const next = loopReducer(s, { type: "EVALUATOR_VERDICT", itemId: "01", verdict: { verdict: "REJECT", reasons: ["x"], evidence: "x" } }, { maxRetries: 2 });
    expect(next.items["01"]!.step).toBe("inbox");
  });

  test("ESCALATE → inbox", () => {
    const s = stateWith({ "01": verifyingItem });
    const next = loopReducer(s, { type: "EVALUATOR_VERDICT", itemId: "01", verdict: { verdict: "ESCALATE", reasons: ["no env"], evidence: "mcp unreachable" } });
    expect(next.items["01"]!.step).toBe("inbox");
  });

  test("non-verifying item unchanged", () => {
    const s = stateWith({ "01": { ...verifyingItem, step: "fixing" } });
    const next = loopReducer(s, { type: "EVALUATOR_VERDICT", itemId: "01", verdict: { verdict: "PASS", evidence: "x" } });
    expect(next.items["01"]!.step).toBe("fixing");
  });

  test("unknown itemId → no-op", () => {
    const s = emptyState();
    const next = loopReducer(s, { type: "EVALUATOR_VERDICT", itemId: "nope", verdict: { verdict: "PASS", evidence: "x" } });
    expect(next).toEqual(s);
  });
});
```

- [ ] **Step 4.4: APPROVE / REJECT_HUMAN / PROMOTE tests**

```typescript
describe("loopReducer — APPROVE / REJECT_HUMAN / PROMOTE", () => {
  const awItem = {
    id: "01", source: "ci", summary: "a", step: "awaiting_review" as const, attempt: 1, priority: 0, result: null,
  };

  test("APPROVE → resolved", () => {
    const s = stateWith({ "01": awItem });
    const next = loopReducer(s, { type: "APPROVE", itemId: "01" });
    expect(next.items["01"]!.step).toBe("resolved");
  });

  test("APPROVE non-awaiting_review → no-op", () => {
    const s = stateWith({ "01": { ...awItem, step: "fixing" } });
    const next = loopReducer(s, { type: "APPROVE", itemId: "01" });
    expect(next.items["01"]!.step).toBe("fixing");
  });

  test("REJECT_HUMAN → inbox with feedback", () => {
    const s = stateWith({ "01": awItem });
    const next = loopReducer(s, { type: "REJECT_HUMAN", itemId: "01", feedback: "wrong approach" });
    expect(next.items["01"]!.step).toBe("inbox");
    expect(next.items["01"]!.result).toEqual({
      verdict: "REJECT",
      reasons: ["wrong approach"],
      evidence: "",
    });
  });

  test("REJECT_HUMAN without feedback → default message", () => {
    const s = stateWith({ "01": awItem });
    const next = loopReducer(s, { type: "REJECT_HUMAN", itemId: "01" });
    expect(next.items["01"]!.result).toEqual({
      verdict: "REJECT",
      reasons: ["手动驳回"],
      evidence: "",
    });
  });

  test("PROMOTE → promoted", () => {
    const s = stateWith({ "01": awItem });
    const next = loopReducer(s, { type: "PROMOTE", itemId: "01" });
    expect(next.items["01"]!.step).toBe("promoted");
  });

  test("PROMOTE non-awaiting_review → no-op", () => {
    const s = stateWith({ "01": { ...awItem, step: "triaged" } });
    const next = loopReducer(s, { type: "PROMOTE", itemId: "01" });
    expect(next.items["01"]!.step).toBe("triaged");
  });
});
```

- [ ] **Step 4.5: RETRY / DISMISS tests**

```typescript
describe("loopReducer — RETRY / DISMISS", () => {
  const inboxItem = {
    id: "01", source: "ci", summary: "a", step: "inbox" as const, attempt: 3, priority: 0,
    result: { verdict: "REJECT" as const, reasons: ["scope drift"], evidence: "x" },
  };

  test("RETRY → triaged, attempt reset, result cleared", () => {
    const s = stateWith({ "01": inboxItem });
    const next = loopReducer(s, { type: "RETRY", itemId: "01" });
    expect(next.items["01"]!.step).toBe("triaged");
    expect(next.items["01"]!.attempt).toBe(1);
    expect(next.items["01"]!.result).toBeNull();
  });

  test("RETRY non-inbox → no-op", () => {
    const s = stateWith({ "01": { ...inboxItem, step: "fixing" } });
    const next = loopReducer(s, { type: "RETRY", itemId: "01" });
    expect(next.items["01"]!.step).toBe("fixing");
  });

  test("DISMISS → item removed", () => {
    const s = stateWith({ "01": inboxItem, "02": { ...inboxItem, id: "02" } });
    const next = loopReducer(s, { type: "DISMISS", itemId: "01" });
    expect(next.items["01"]).toBeUndefined();
    expect(next.items["02"]).toBeDefined();
  });

  test("DISMISS non-inbox → no-op", () => {
    const s = stateWith({ "01": { ...inboxItem, step: "fixing" } });
    const next = loopReducer(s, { type: "DISMISS", itemId: "01" });
    expect(next.items["01"]).toBeDefined();
  });

  test("DISMISS unknown itemId → no-op", () => {
    const s = emptyState();
    const next = loopReducer(s, { type: "DISMISS", itemId: "nope" });
    expect(next).toEqual(s);
  });
});
```

- [ ] **Step 4.6: ADD_ITEM tests**

```typescript
describe("loopReducer — ADD_ITEM", () => {
  test("new item added as triaged", () => {
    const s = emptyState();
    const next = loopReducer(s, { type: "ADD_ITEM", item: { id: "01", source: "ci", summary: "auth flaky" } });
    expect(next.items["01"]).toBeDefined();
    expect(next.items["01"]!.step).toBe("triaged");
    expect(next.items["01"]!.attempt).toBe(1);
    expect(next.items["01"]!.priority).toBe(0);
    expect(next.items["01"]!.result).toBeNull();
  });

  test("ADD_ITEM with explicit priority", () => {
    const s = emptyState();
    const next = loopReducer(s, { type: "ADD_ITEM", item: { id: "01", source: "ci", summary: "critical" }, priority: 1 });
    expect(next.items["01"]!.priority).toBe(1);
  });

  test("ADD_ITEM id conflict → no-op, original preserved", () => {
    const existing = { id: "01", source: "ci", summary: "original", step: "fixing" as const, attempt: 2, priority: 5, result: null };
    const s = stateWith({ "01": existing });
    const next = loopReducer(s, { type: "ADD_ITEM", item: { id: "01", source: "issue", summary: "duplicate" } });
    expect(next.items["01"]!.step).toBe("fixing");
    expect(next.items["01"]!.summary).toBe("original");
    expect(next.items["01"]!.priority).toBe(5);
  });
});
```

- [ ] **Step 4.7: Immutability test**

```typescript
describe("loopReducer — immutability", () => {
  test("returned state is new object (shallow)", () => {
    const s = emptyState();
    const next = loopReducer(s, { type: "TICK" });
    expect(next).not.toBe(s);
    expect(next.items).not.toBe(s.items);
  });
});
```

- [ ] **Step 4.8: Run all tests**

```bash
cd packages/loop && bun test
```

Expected: 28 tests, all PASS.

- [ ] **Step 4.9: Commit**

```bash
git add packages/loop/src/loop-reducer.test.ts && git commit -m "test(loop-engine): 28 tests covering all actions, edges, immutability"
```

---

### Task 5: 收尾验证

- [ ] **Step 5.1: Full workspace verification**

```bash
bun run typecheck && bun run lint && bun run test
```

Expected: PASS for typecheck + lint; all existing tests + 28 new loop-engine tests PASS.

- [ ] **Step 5.2: Commit**

```bash
git add -A && git commit -m "chore(loop-engine): verify full workspace typecheck, lint, test"
```
