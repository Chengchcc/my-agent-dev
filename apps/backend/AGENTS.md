# AGENTS.md — apps/backend

Working contract for the Product Backend (Elysia HTTP/SSE server). It is
the single truth source for agent runs, conversations, workflows,
artifacts, and all product-side state.

## What this app is

- Elysia HTTP server (auth token, SSE streams, Eden Treaty)
- Drizzle ORM + SQLite (`src/infra/db/schema.ts`)
- Composition-root DI (`src/main.ts` wires adapters → services → routes)
- Spawns child agent processes through `packages/adapter-*`
- Runs workflow DSL (`packages/workflow`) with a process sandbox
  (`packages/sandbox`)

## Commands

Run from `apps/backend`:

```bash
bun run dev          # build dependencies then run src/main.ts
bun run build        # tsc -p tsconfig.json
bun run typecheck    # tsc -p tsconfig.test.json --noEmit
bun run lint         # biome check . && eslint .
bun run test         # bun test
```

## Architecture

Every feature follows the same hexagonal shape under `src/features/`:

```
features/<name>/
  domain.ts          # pure types + domain logic (no I/O)
  ports.ts           # storage boundary interface
  service.ts         # business logic factory: createXxxService(deps)
  adapter-sqlite.ts  # drizzle implementation of ports
  http.ts            # Elysia route plugin
  index.ts           # barrel re-exports
```

Composition happens in `src/bootstrap/` (`features.ts`, `services.ts`) and
`src/main.ts`. Do not create services/adapters inside `http.ts`.

## Import conventions

- **Internal imports are relative with `.js` extension** because the app
  compiles to ESM under `NodeNext` (`import { x } from "./feature/http.js"`).
  Do not use extensionless relative imports.
- **Cross-package imports use `@chengchenccc/*` package names**
  (`@chengchenccc/message`, `@chengchenccc/agent-contract`, etc.). Never
  import through a monorepo path like `../../packages/...`.
- **Do not read `process.env` inside feature code.** Environment config is
  loaded only through `packages/config` (`loadConfig()` / `parseEnv`) and
  passed into services as `BackendConfig`.

## Rules and invariants

- `BackendRunOutcome` is the **only** terminal authority for an agent run.
  Never invent a run status in the service layer.
- Runs are dispatched through `features/agent-run/execution.ts`; the
  backend spawns a child adapter process per run and persists canonical
  messages to the conversation ledger.
- Workflow executions start via `workflowRef` file references, not inline
  definitions. The `end` node status decides terminal state: only
  `success` maps to success; anything else is `custom`.
- Workflow script nodes receive the **bare input record** as `ctx` (sandbox
  contract), not a legacy `ScriptContext` envelope.
- DB migrations are hand-written SQL + journal entries. If you write a
  migration with multiple statements, put `-- statement-breakpoint` between
  them; otherwise `bun:sqlite` silently executes only the first statement.
- Use typed errors (`DomainError`, `HttpError`) and let `app.ts` `onError`
  translate them to JSON.

## Known pitfalls

- **Web depends on built dist types.** After changing backend route/handler
  return types, run `backend typecheck → backend build → web typecheck`.
  Web imports `@my-agent-team/backend/app` and sees `dist` types.
- **Migration breakpoints:** verify with `sqlite3 count` / `PRAGMA
  table_info` after migrating; journal presence alone does not prove all
  statements ran.
- **Child process lifecycle:** spawned adapters must be cleaned up; tests
  that spawn long-sleeping children keep `bun test` alive until the child
  exits.
- **Smoke cron:** `SMOKE_CRON` uses Bun.cron (5-field, UTC). The smoke
  script must spawn outside a workflow to avoid booting a second backend
  inside a product execution.
## Related docs

Cross-file entry points to read before touching a feature:

- [docs/architecture/index.llm.md](../../docs/architecture/index.llm.md) — repo doc hub
- [docs/architecture/backend/overview.md](../../docs/architecture/backend/overview.md)
- [docs/architecture/backend/data-model.md](../../docs/architecture/backend/data-model.md)
- [docs/architecture/workflow.md](../../docs/architecture/workflow.md)
- [docs/architecture/e2e-contract-rules.md](../../docs/architecture/e2e-contract-rules.md)

## Review checklist

## Review checklist

1. `bun run typecheck` passes.
2. `bun run lint` passes.
3. `bun run test` passes.
4. If web consumes new/changed API types, build backend before trusting
   web typecheck.
