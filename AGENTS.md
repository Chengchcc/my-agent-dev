# Agent Principles

## Implementation Principles

**Long-termism.** Make decisions that minimize integral cost over time, not instantaneous cost at the current moment. A shortcut today creates path-dependency and future correction cost; a one-time structural investment preserves decision-space freedom. Optimize for the trajectory, not the point.

**Elegance first.** Elegance is the minimum-entropy solution given the current information level and long-term objective. Prefer simple, practical implementations without over-engineering. An elegant solution sits at the low point of the characteristic surface at constant information — no less, no more.

## Thinking Principles

**First principles.** Reject empiricism and path-following. Do not assume the user is fully clear on their goal — stay vigilant, start from raw requirements and the problem itself. If the goal is ambiguous, pause and discuss with the user. If the goal is clear but the path is suboptimal, directly propose a shorter, lower-cost alternative.

**Challenge implicit assumptions.** Identify hidden premises in user questions. If a premise is wrong, correct it before answering. Use numbers over adjectives. Give definitive judgments over hedged positions.

### Response Structure

Every response has two parts:
- **Direct execution.** Execute the task as requested, following the user's current logic.
- **Deep interaction** (when applicable). Challenge the user's intent against first principles: question whether motives deviate from the goal (XY problem), expose hidden costs or downsides of the current path, offer more elegant alternatives. If derivation requires missing data, state what's needed rather than obscure uncertainty with vague language.

### Relationship with the User

- Your loyalty is to **truth**, not to the user's expectations.
- Challenge the user's views with respect but without retreat — gently insist, don't politely obscure.
- If the user presents better facts or reasoning, correct your conclusion immediately without pointless defense.
- Cross-reference `docs/architecture/design-philosophy.md` when making design decisions.

# Repository Guidelines
## Project Overview

`my-agent-team` is a monorepo for building multi-agent AI systems. It spans from a protocol-level agent runtime (`packages/message`, `apps/oh-my-agent/src/core`) through a production backend (`apps/backend`) and web UI (`apps/web`), plus a Agentic Workflow engine.

**Tech stack:** Bun 1.3.14 runtime, TypeScript 6.x (ESM, `NodeNext`), Turborepo v2, Elysia HTTP, Drizzle ORM + SQLite, Next.js 15 App Router, React Query v5, shadcn/ui + Tailwind CSS v4, Biome + ESLint.

## Architecture & Data Flow

```
L5 Surfaces     Frontend web / IM bot - talk HTTP/SSE to backend
L4 Backend      Multi-agent service (Elysia HTTP, auth, tenancy, runner pool)
L3 Adapter      packages/adapter-* - child process boundary (spawn / JSONL RPC / steer / abort / approval)
L2 Runtime      apps/oh-my-agent/src/core - createOmaSession(): model/tool loop, plugins, compaction, todo
L1 Protocols    Type contracts: Message / ChatModel / Tool / ContentBlock / WorkflowDefinition (packages/message, agent-contract, workflow)
```

**Package dependency graph:**
- Leaves: `@chengchenccc/message`, `@chengchenccc/config`, `@chengchenccc/workflow`, `@chengchenccc/sandbox`, `@chengchenccc/source-fetch`, `@chengchenccc/tui`
- Contracts: `@chengchenccc/agent-contract` (spawn-neutral `AgentBackend`; the 4 adapters implement it)
- Plugins: 0 plugins as standalone packages; oma-native todo/progressive-skill live in `apps/oh-my-agent/src/core`
- Apps: `@chengchenccc/backend` (consumes all), `@chengchenccc/web` (Next.js), `@chengchenccc/lark-bot`, `@chengchenccc/oh-my-agent` (oma CLI)

**Data flow:** Backend is the single truth source. Frontend uses Eden Treaty typed client to call BFF proxy (`/api/bff/[...path]`) which forwards to backend with auth headers. SSE events from backend flow through Next.js BFF to React Query subscriptions.

## Key Directories

| Directory | Purpose |
|---|---|
| `packages/message/` | Protocol layer: Message/MessageRevision + ChatModel/Tool/AIMessageChunk + stream utils (absorbed the former core package) |
| `apps/oh-my-agent/src/core/` | Oma runtime: `createOmaSession()` (agent-loop), plugins, compaction, persistence (absorbed the former agent package) |
| `apps/backend/src/features/workflow/` | Agentic Workflow DSL engine: triggers, executions, human tasks |
| `packages/ai/` | Provider + Model registry, AnthropicChatModel, model metadata |
| `packages/workflow/` | Agentic Workflow DSL pure domain: node graph, JSON-Logic routing, computeNext engine |
| `packages/sandbox/` | Process sandbox for workflow script nodes + oma eval tool |
| `packages/test-helpers/` | `echoModel()` for deterministic test doubles |
| `apps/oh-my-agent/src/core/tools/` | Oma-native tools: read/write/edit/bash/grep/glob/web/eval + MCP mount |
| `apps/backend/` | Elysia server: all services, routes, workflow trigger scheduling |
| `apps/web/` | Next.js 15 App Router: agents, conversations, workflow, ops, skill-packs |
| `apps/lark-bot/` | Lark/Feishu IM bot integration |
| `apps/oh-my-agent/` | Oma CLI agent runtime (spawned `--mode rpc` by backend adapters) |
| `skills/` | Skill packs (SKILL.md + registry.yaml) for agent runtime |
| `docs/` | Architecture docs, ADRs, superpowers (specs/plans) |

## Development Commands

```bash
bun install                    # Install dependencies
bun run build                  # Build all packages (turbo)
bun run dev                    # Start dev servers
bun run format                 # Biome format all files
bun run lint                   # Biome check + ESLint
bun run typecheck              # tsc --noEmit across all packages (turbo)
bun run test                   # Run all tests (turbo)
bun test                       # Run tests at root

# Scoped commands:
cd apps/oh-my-agent && bun test --test-name-pattern="agent-loop"
cd apps/backend && bun run typecheck
```

**Per-package scripts:** Every package has `build`, `typecheck`, `test` scripts (lint coverage varies by package).

## Code Conventions & Common Patterns

### Imports: No deep imports
Cross-package imports MUST go through the barrel (`index.ts`). `import { parseWorkflow } from "@chengchenccc/workflow"` not `"@chengchenccc/workflow/src/parse.js"`. Enforced by ESLint `consistent-type-imports`.

### Dependency Injection
Backend uses **composition-root DI** (no framework): `main.ts` creates adapters, injects them into service factories, then mounts HTTP routes. Every feature follows hexagonal architecture:

```
domain.ts          — Pure types, entity interfaces
ports.ts           — Storage boundary interface
service.ts         — Business logic (factory pattern: `createXxxService(deps)`)
adapter-sqlite.ts  — Drizzle ORM implementation
http.ts            — Elysia routes
index.ts           — Barrel re-exports
```

### Agent Session Creation
`createOmaSession(opts)` in `apps/oh-my-agent/src/core/runtime/agent-loop.ts` materializes an Oma session:
```typescript
{
  sessionId: string;
  store: SessionStore;      // in-memory or persisted (message store)
  plugins: Plugin[];        // hooks + tools (oma-native plugins in apps/oh-my-agent)
  maxSteps: number;
  maxForceContinues: number;
  modelStream: (messages, signal?, tools?) => AsyncIterable<AIMessageChunk>;
  tools?: PluginTool[];     // per-run resolved tool table
}
```
Backend run dispatch (`apps/backend/src/features/agent-run/execution.ts`) enqueues inputs, spawns the oma child through `packages/adapter-oma-agent`, and persists canonical messages via the conversation ledger.

### Plugin System
Plugins are plain objects `{ name, hooks?, tools?, meta? }` contributing tools, lifecycle hooks, and meta sections (see `Plugin` in `apps/oh-my-agent/src/core/runtime/plugin.ts`):
```typescript
interface PluginHooks {
  beforeRun?(messages, rt): void;
  afterRun?(status, messages, rt): void | Promise<void>;
  beforeModel?(messages, rt): readonly Message[];
  afterModel?(messages, rt): void;
  beforeTool?(toolName, input, rt): { block?, reason? } | undefined;
  afterTool?(toolName, result, rt): OmaLoopEvent | { content?, isError?, terminate? } | undefined;
  transformToolArgs?(toolName, input, rt): unknown;
  beforeStop?(cancel, rt): void;
  afterStop?(vetoed, rt): void;
}
```

`validatePlugins()` checks name/tool collisions; `collectTools()` and `renderMeta()` assemble the per-run tool table and meta sections.

### ChatModel is the only integration point
Core has no LLM dependency. `ChatModel.stream(messages, opts?) → AsyncIterable<AIMessageChunk>` is the contract. Tests use `echoModel()` from `@chengchenccc/test-helpers`.

### Workflow System
Two layers: **packages/workflow** (pure domain: `WorkflowDefinition` DSL, `computeNext` engine, JSON-Logic routing, schema validation) + **apps/backend/src/features/workflow** (executions, node runs, human forms, trigger scheduler, SSE live stream).

- Node types: `start` / `end` / `agent` (dispatches an Agent Run; outputSchema-constrained) / `script` (runs in `@chengchenccc/sandbox`) / `human` (`waiting_human` + web form)
- Routing is frozen into `CompletionRecord.routedTo` at node completion — never recomputed; join semantics = any-of
- Triggers: cron via Bun.cron trigger-scheduler over `workflows/*.workflow.json`

### File Naming
- Source: `*.ts`, tests: `*.test.ts` (beside source, no `__tests__` dirs)
- Feature features: `domain.ts`, `ports.ts`, `service.ts`, `adapter-sqlite.ts`, `http.ts`, `index.ts`
- Barrel files: every package/feature has `index.ts` re-exporting public API

### Error Handling
- Backend: Elysia `.onError` handler translates `HttpError` + `NOT_FOUND` to JSON
- Service layer: throw typed errors (`ProjectNotFoundError`, `ValidationError`)
- Workflow: node failures are captured per node-run; the execution terminalizes as failure (cancel unwinds the drive loop)
- Agent: `permissionMode="ask"` tools go through the approval pipeline (`approval_request` event → `resolve_approval`; timeout denies)

## Important Files

| File | Purpose |
|---|---|
| `apps/backend/src/main.ts` | Composition root — wires all services, adapters, routes |
| `apps/backend/src/app.ts` | Elysia app factory — mounts all feature routers |
| `apps/backend/src/features/agent-run/execution.ts` | Run dispatch, transient SSE subscription, terminalize |
| `apps/backend/src/infra/db/schema.ts` | Drizzle schema — 21 tables, single SQLite file |
| `apps/oh-my-agent/src/core/runtime/agent-loop.ts` | `createOmaSession()` — the agent loop |
| `apps/oh-my-agent/src/core/runtime/plugin.ts` | `Plugin`/`PluginHooks`, `validatePlugins()` |
| `packages/message/src/chat-model.ts` | `ChatModel` contract |
| `packages/ai/src/providers/anthropic-messages.ts` | Anthropic Messages API adapter |
| `apps/web/src/lib/api.ts` | Typed API client (Eden Treaty) |
| `apps/web/src/lib/client.ts` | BFF client + `unwrap()` helper |
| `biome.json` | Formatter (space/2/100) + linter config |
| `turbo.json` | Build pipeline (concurrency=1 for safety) |
| `tsconfig.base.json` | Shared strict TS config |
| `docs/architecture/design-philosophy.md` | 8 architectural principles |
| `docs/architecture/e2e-contract-rules.md` | Anti-fragmentation rules for cross-process types |
| `docs/architecture/db-typesafe-rules.md` | DB type chain rules (schema → service → http) |

## Runtime/Tooling Preferences

- **Runtime:** Bun only (do not suggest Node.js-specific APIs)
- **Package manager:** `bun install` (bun.lock)
- **Formatting:** Biome (space/2/100, single quotes)
- **Linting:** Biome (recommended rules) + ESLint (TS-specific: `consistent-type-imports`, `no-unused-vars`)
- **TypeScript:** ESM with `NodeNext` resolution, target ES2023, strict mode, `noUncheckedIndexedAccess`
- **Git hooks:** Husky pre-commit (biome format + check) + commit-msg (commitlint conventional commits, no CJK)
- **CI:** `bun run typecheck && bun run lint && bun run test`
- **Package naming:** `@chengchenccc/<domain-name>` (domain-level, not engine/utility-level)

## Testing & QA

- **Framework:** `bun:test` (`describe`/`test`/`expect`)
- **Location:** `*.test.ts` files beside source
- **Model mocking:** Define scripted `ChatModel` implementations that yield predetermined turns. `echoModel()` from `@chengchenccc/test-helpers` provides a reusable factory.
- **Session store double:** `createInMemorySessionStore()` from `apps/oh-my-agent/src/core/persistence`
- **Integration tests:** Use `createOmaSession()` with real plugin hooks and scripted models
- **Workflow tests:** `packages/workflow` (engine/parse/schema) + `apps/backend/src/features/workflow/service.test.ts` / `trigger-scheduler.test.ts`
- **Coverage:** No enforced threshold; tests should cover behavior (conditional branches, invariants, error handling), not plumbing
- **Test helpers:** `@chengchenccc/test-helpers` exports `echoModel()` with `EchoScript` type for deterministic model responses
