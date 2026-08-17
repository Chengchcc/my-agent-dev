# @chengchenccc/loop

Pure-function state reducer for the Loop work system. Implements the item step state machine defined in `docs/architecture/foundations/loop.md`.

## Exports

| Symbol | Kind | Description |
|---|---|---|
| `loopReducer(state, action, opts?)` | function | Pure state machine — `LoopState → LoopAction → LoopState` |
| `LoopState` | type | Full loop state (items, lastRun, loopId) |
| `ItemState` | type | Single work item (id, step, attempt, verdict, etc.) |
| `LoopAction` | type | Discriminated union of all 9 action types |
| `Verdict` | type | Evaluator verdict: PASS, REJECT, or ESCALATE |
| `ItemStep` | type | `"triaged" | "fixing" | "verifying" | "awaiting_review" | "resolved" | "inbox" | "promoted"` |
| `ItemId` | type | `string` (ULID) |

## Usage

```typescript
import { loopReducer } from "@chengchenccc/loop";

const state = { loopId: "morning-triage", lastRun: null, items: {} };

// Discovery finds items → ADD_ITEM
let s = loopReducer(state, {
  type: "ADD_ITEM",
  item: { id: "01", source: "ci/4821", summary: "auth flaky" },
});

// Cron TICK → all triaged become fixing
s = loopReducer(s, { type: "TICK" });

// Generator done → item moves to verifying
s = loopReducer(s, { type: "GENERATOR_DONE", itemId: "01" });

// Evaluator verdict → PASS → awaiting_review
s = loopReducer(s, {
  type: "EVALUATOR_VERDICT",
  itemId: "01",
  verdict: { verdict: "PASS", evidence: "12/12 green" },
});

// Human approves → resolved
s = loopReducer(s, { type: "APPROVE", itemId: "01" });
```

## No dependencies

This package is a pure TypeScript module. It imports nothing from `@chengchenccc/*` or any third-party library.
