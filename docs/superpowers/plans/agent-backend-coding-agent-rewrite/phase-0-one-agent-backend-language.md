# Phase 0 — One Agent Backend Language

**Goal:** Create `@my-agent-team/agent-backend` as the only implementation-independent Agent Run contract.

**Outcome:** The package builds, typechecks, and tests alone; a fake Agent Backend implements the full interface; consumers use its barrel for events/outcomes; incomplete inputs and forbidden legacy names fail contract checks.

**Prerequisites:**
- Treat `docs/superpowers/specs/agent-backend-coding-agent-rewrite/phase-0-contracts.md` as authoritative.
- Read `docs/architecture/execution/agent-backend.md` and `docs/architecture/runtime/coding-agent-models.md:115-148`.
- Follow `_template/package/{package.json,tsconfig.json,tsconfig.test.json}`.
- Reuse `Message` only from `packages/message/src/index.ts`; do not re-export through or modify `packages/core/src/index.ts`.
- Phase 0 has no prerequisite. It gates Phases 1 and 2. Product caller cutover is Phase 5 only.

**Non-goals:** No adapter, transport, runtime, daemon, DB, Product Backend caller change, Zod boundary parser, compatibility alias, dual write, or old session/checkpoint migration.

**Estimated size:** 7 cards, 2.5–3.5 hours.

## Fixed file map

| File | Purpose |
|---|---|
| `packages/agent-backend/package.json` | Package metadata; only dependency is Message |
| `packages/agent-backend/tsconfig.json` | Production build |
| `packages/agent-backend/tsconfig.test.json` | Contract-test typecheck |
| `packages/agent-backend/src/model.ts` | Model ref/catalog contracts |
| `packages/agent-backend/src/history.ts` | Projected history and Run snapshot |
| `packages/agent-backend/src/run.ts` | Inputs, session, continuation, outcomes |
| `packages/agent-backend/src/event.ts` | Events and usage |
| `packages/agent-backend/src/backend.ts` | Capabilities and Agent Backend API |
| `packages/agent-backend/src/index.ts` | Explicit type-only barrel |
| `packages/agent-backend/src/contracts.test.ts` | Fake Backend and contract guards |
| `bun.lock` | Workspace link update |

## Wave 1 — Create the package and foundational contracts

### Card 1 — Scaffold the package

**Time box:** 20 minutes

**Files:**
- Create `packages/agent-backend/package.json`
- Create `packages/agent-backend/tsconfig.json`
- Create `packages/agent-backend/tsconfig.test.json`
- Create `packages/agent-backend/src/index.ts`
- Modify `bun.lock`

**Actions:**
1. Run `bun run create`; choose `packages`, directory `agent-backend`, package `@my-agent-team/agent-backend`, description `Implementation-independent Agent Backend contracts`.
2. Keep the generated tsconfigs. Set `test` to `bun test`.
3. Add exactly one dependency: `"@my-agent-team/message": "workspace:*"`; leave `devDependencies` empty.
4. Run `bun install`.

Use the template manifest shape with this scripts/dependency section:

```json
"scripts": {
  "build": "tsc -p tsconfig.json",
  "lint": "biome check . && eslint .",
  "test": "bun test",
  "typecheck": "tsc -p tsconfig.test.json --noEmit"
},
"dependencies": {
  "@my-agent-team/message": "workspace:*"
},
"devDependencies": {}
```

**Check:**

```bash
bun -e 'const p=await Bun.file("packages/agent-backend/package.json").json(); console.log(p.name,Object.keys(p.dependencies??{}))'
```

Expected: package name plus only `@my-agent-team/message`.

**Done when:** The workspace sees the package and its manifest has no other dependency.

### Card 2 — Define model and history contracts

**Time box:** 25 minutes

**Files:**
- Create `packages/agent-backend/src/model.ts`
- Create `packages/agent-backend/src/history.ts`

**Actions:**
1. Add these exact model contracts:

```ts
export interface BackendModelRef {
  readonly backendKind: string;
  readonly modelId: string;
}

export interface BackendModel {
  readonly id: string;
  readonly displayName: string;
  readonly reasoning: boolean;
  readonly inputModalities: readonly string[];
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly available: boolean;
}

export interface BackendModelCatalog {
  readonly backendKind: string;
  readonly models: readonly BackendModel[];
}
```

2. Add these exact history/config contracts; import `Message` from `@my-agent-team/message` and `BackendModelRef` from `./model.js`:

```ts
export interface ProjectedHistoryItem {
  readonly productEntryId: string;
  readonly message: Message;
}

export interface WorkspaceBinding {
  readonly root: string;
  readonly access: "read_only" | "read_write";
}

export interface ProductToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly entrypoint: string;
}

export interface AgentRunSnapshot {
  readonly runId: string;
  readonly model: BackendModelRef;
  readonly systemPrompt?: string;
  readonly productTools: readonly ProductToolDescriptor[];
  readonly configRevision: number;
}
```

3. Do not add provider objects, credentials, DB records, Runtime plugins, or a second Message shape.

**Check:**

```bash
bun run --cwd packages/agent-backend build
```

Expected: exit 0 and declarations for `model.ts` and `history.ts`.

**Done when:** Model selection, stable `productEntryId`, workspace boundary, Product Tool manifest, and immutable Run snapshot compile using Message as the sole message model.

## Wave 2 — Freeze execution, outcomes, and events

### Card 3 — Define event and usage contracts

**Time box:** 20 minutes

**Files:**
- Create `packages/agent-backend/src/event.ts`


**Actions:**
1. Add `Usage` with optional token/cache/cost fields.
2. Add the stable core event union from Card 4 below.
3. Reserve `backend.<kind>.*` for opaque Backend-specific events.

**Check:**
```bash
bun run --cwd packages/agent-backend build
```
Expected: exit 0; event contracts compile independently.

**Done when:** Usage and BackendEvent exist before any Run type imports them.

### Card 4 — Define Run, continuation, and Agent Backend contracts

**Time box:** 30 minutes

**Files:**
- Create `packages/agent-backend/src/run.ts`
- Create `packages/agent-backend/src/backend.ts`
**Actions:**
1. Add `BackendStartInput` and `BackendRunInput`; both require `run: AgentRunSnapshot`.
2. Add the opaque session handle, pending action types, segment, session-run pair, and outcomes.
3. Add `AgentBackendCapabilities` and the exact `start/send/resume/respond/stop/close` interface.
4. Keep `suspended` separate from terminal statuses.
```ts
export interface BackendStartInput {
  readonly history: readonly ProjectedHistoryItem[];
  readonly run: AgentRunSnapshot;
  readonly workspace: WorkspaceBinding;
  readonly env?: Readonly<Record<string, string>>;
  readonly metadata: {
    readonly conversationId: string;
    readonly agentMemberId: string;
    readonly branchId: string;
    readonly productRevision: number;
  };
}

export interface BackendRunInput {
  readonly messages: readonly ProjectedHistoryItem[];
  readonly run: AgentRunSnapshot;
  readonly mode: "normal" | "steer" | "follow_up";
  readonly metadata: {
    readonly branchId: string;
    readonly throughEntryId?: string;
    readonly productRevision: number;
  };
}

export interface BackendSessionHandle {
  readonly backendSessionId: string;
  readonly backendKind: string;
  readonly state: "open" | "closed";
}

export interface PendingAction {
  readonly actionId: string;
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface PendingActionResponse {
  readonly actionId: string;
  readonly response: unknown;
}

export type BackendRunOutcome =
  | { readonly status: "completed"; readonly output?: Message; readonly usage?: Usage }
  | { readonly status: "suspended"; readonly pendingAction: PendingAction; readonly usage?: Usage }
  | { readonly status: "failed" | "aborted" | "timeout"; readonly error?: string; readonly usage?: Usage };

export interface BackendRunSegment {
  readonly events: AsyncIterable<BackendEvent>;
  readonly outcome: Promise<BackendRunOutcome>;
  stop(): Promise<void>;
}

export interface BackendSessionRun {
  readonly session: BackendSessionHandle;
  readonly segment: BackendRunSegment;
}
```

Use type-only imports from `@my-agent-team/message`, `./history.js`, and the already-created `./event.js`.

**Check:**

```bash
bun run --cwd packages/agent-backend build
```

Expected: exit 0. Type-only circular references do not produce runtime imports.

**Done when:** `runId`, `branchId`, `productEntryId`, `backendSessionId`, and `actionId` remain distinct; no generic `ExecutionId` exists.

## Wave 3 — Export and prove the contract

### Card 5 — Publish the type-only barrel

**Time box:** 15 minutes

**Files:**
- Replace `packages/agent-backend/src/index.ts`

**Actions:**
1. Delete the template `packageName()` export.
2. Add explicit `export type` statements for every required public name:

```ts
export type { AgentBackend, AgentBackendCapabilities } from "./backend.js";
export type { BackendEvent, Usage } from "./event.js";
export type { AgentRunSnapshot, ProductToolDescriptor, ProjectedHistoryItem, WorkspaceBinding } from "./history.js";
export type { BackendModel, BackendModelCatalog, BackendModelRef } from "./model.js";
export type {
  BackendRunInput,
  BackendRunOutcome,
  BackendRunSegment,
  BackendSessionHandle,
  BackendSessionRun,
  BackendStartInput,
  PendingAction,
  PendingActionResponse,
} from "./run.js";
```

3. Do not use `export *`, runtime factories, schemas, aliases, or re-exports from `core`/`agent`.

**Check:**

```bash
bun run --cwd packages/agent-backend build
```

Expected: `dist/index.d.ts` contains all required types; `dist/index.js` has no contract implementation.

**Done when:** Consumers need only `@my-agent-team/agent-backend`.

### Card 6 — Add contract tests and negative type guards

**Time box:** 30 minutes

**Files:**
- Create `packages/agent-backend/src/contracts.test.ts`

**Actions:**
1. Implement `FakeBackend implements AgentBackend` with all six methods. Use one local empty async iterable and deterministic completed segments; do not create an adapter base class.
2. Test `start()`, consume `segment.events`, await `segment.outcome`, and assert session/outcome using types imported only from `./index.js`.
3. Add `// @ts-expect-error` assignments proving a `BackendRunInput` without `run` and a `ProjectedHistoryItem` without `productEntryId` fail.
4. Add `// @ts-expect-error` type imports for `ProductTurn`, `RuntimeBinding`, `runtimeSessionId`, `AgentSessionPool`, `AgentLoop`, `SpanResult`, and `ExecutionId`; add a negative capabilities assignment containing `nativeFork`.
5. Add a Bun test reading `../package.json` from `import.meta.url` and asserting dependencies equal `{ "@my-agent-team/message": "workspace:*" }` and devDependencies equal `{}`.

Minimal segment helper:

```ts
async function* noEvents(): AsyncIterable<BackendEvent> {}

function completedSegment(): BackendRunSegment {
  return {
    events: noEvents(),
    outcome: Promise.resolve({ status: "completed" }),
    async stop() {},
  };
}
```

Use `{ role: "user", text: "hello" }` as the `Message` inside a projected history item.

**Check:**

```bash
bun run --cwd packages/agent-backend typecheck
bun run --cwd packages/agent-backend test
```

Expected: both exit 0; each `@ts-expect-error` is exercised and Bun reports all tests passing.

**Done when:** The fake Backend compiles, the barrel-only consumer works, required fields are compile-enforced, and forbidden names stay absent.

## Wave 4 — Phase gate

### Card 7 — Run focused dependency and public API checks

**Time box:** 25 minutes

**Files:**
- Verify `packages/agent-backend/**`
- Verify `bun.lock`
- Do not edit any adapter, app, `packages/agent`, `packages/core`, or `packages/message` file

**Actions:**
1. Run package build, typecheck, and tests.
2. Run dependency/import denylists.
3. Run generated-public-API allowlist and denylist checks.
4. Check changed-file scope.
5. Stop before adapters or caller cutover.

**Check:**

```bash
bun run --cwd packages/agent-backend build
bun run --cwd packages/agent-backend typecheck
bun run --cwd packages/agent-backend test
```

Expected: all exit 0.

```bash
bun -e 'const p=await Bun.file("packages/agent-backend/package.json").json(); const a=Object.keys(p.dependencies??{}).sort(); if(JSON.stringify(a)!==JSON.stringify(["@my-agent-team/message"])) throw new Error(a.join(",")); console.log("dependency allowlist: PASS")'
```

Expected: `dependency allowlist: PASS`.

```bash
if grep -R -n -E 'from "(@my-agent-team/(agent|ai|core)|elysia|drizzle-orm|bun:sqlite)' packages/agent-backend/src; then exit 1; else echo "source dependency denylist: PASS"; fi
```

Expected: `source dependency denylist: PASS`.

```bash
if grep -R -n -E '\b(ProductTurn|RuntimeBinding|runtimeSessionId|AgentSessionPool|AgentLoop|SpanResult|ExecutionId|nativeFork)\b' packages/agent-backend/dist; then exit 1; else echo "public-name denylist: PASS"; fi
```

Expected: `public-name denylist: PASS`.

```bash
for name in BackendModelRef BackendModel BackendModelCatalog ProjectedHistoryItem AgentRunSnapshot WorkspaceBinding ProductToolDescriptor BackendStartInput BackendRunInput BackendSessionHandle BackendSessionRun BackendRunSegment BackendRunOutcome PendingAction PendingActionResponse BackendEvent Usage AgentBackendCapabilities AgentBackend; do
  grep -q "$name" packages/agent-backend/dist/index.d.ts || exit 1
done
echo "required public exports: PASS"
```

Expected: `required public exports: PASS`.

```bash
git status --short -- packages/agent-backend bun.lock packages/agent packages/core packages/message apps
```

Expected: changes only in `packages/agent-backend/**` and `bun.lock`.

**Done when:** Every focused command passes and no adapter or caller work exists.

## Final phase gate

- [ ] Package independently builds, typechecks, and tests.
- [ ] Only dependency is `@my-agent-team/message`; no backend app, agent, ai, core, Elysia, Drizzle, `bun:sqlite`, or Provider SDK import.
- [ ] Message is reused, not copied.
- [ ] All Phase 0 public types are exported from the root.
- [ ] Both start/resume and send inputs require `AgentRunSnapshot`.
- [ ] Missing `run` and missing `productEntryId` fail typecheck.
- [ ] Fake Backend implements all six methods.
- [ ] Barrel-only consumer handles events and outcome.
- [ ] Terminal statuses are completed/failed/aborted/timeout; suspended carries `PendingAction` and is nonterminal for the Agent Run.
- [ ] Capabilities are exactly the six frozen fields; no `nativeFork`.
- [ ] Core events are frozen; extensions use `backend.<kind>.<event>`.
- [ ] Specific IDs remain distinct; no generic `ExecutionId`.
- [ ] No `ProductTurn`, `RuntimeBinding`, `runtimeSessionId`, `AgentSessionPool`, `AgentLoop`, or `SpanResult` public API.
- [ ] No compatibility shim, adapter, transport, runtime, migration, or caller cutover.
- [ ] Changed scope is only `packages/agent-backend/**` and `bun.lock`.

**Handoff:** Phase 1 and Phase 2 may now proceed in parallel against this package. Product callers remain unchanged until Phase 5.
