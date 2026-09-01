# AGENTS.md — apps/oh-my-agent

Working contract for the **Oma CLI** (`oma`). This is the runtime agent
core that the Product Backend spawns for each Run.

## What this app is

- A run-centric CLI agent in four modes: `print`, `json`, `rpc`, and
  interactive `tui`.
- `rpc` mode is the product integration surface: the backend adapter spawns
  `oma --mode rpc` and speaks JSONL over stdin/stdout.
- `print`/`json` are one-shot CLI modes; `tui` is a full interactive
  terminal with streaming render, branch tree, tools, and slash commands.

## Commands

Run from `apps/oh-my-agent`:

```bash
bun run dev          # bun src/cli.ts
bun run build        # tsc -p tsconfig.json + copy prompts + chmod dist/cli.js
bun run typecheck    # tsc -p tsconfig.test.json --noEmit
bun run lint         # biome check . && eslint .
bun run test         # bun test
```

## Architecture

```
src/
  cli.ts               # entrypoint
  main.ts              # mode dispatch + argument parsing
  core/
    create-runtime.ts  # createOmaSession / createCodingAgentRuntime
    run-runtime.ts     # RunRuntimeDeps, createOmaRuntime
    agent-loop.ts      # message/model/tool loop
    plugin.ts          # Plugin + hooks + validatePlugins
    plugin-runtime.ts  # runtime capabilities injected into hooks
    tool-filter.ts     # --tools whitelist/blacklist
  modes/
    print-mode.ts
    json-mode.ts
    rpc-mode.ts        # JSONL protocol (stdout is protocol-only)
    tui/
  core/tools/          # native tools (bash, grep, todo, eval, ...)
  core/plugins/        # plugin loading/trust
  core/memory/         # autonomous memory
```

## Cross-file imports

- **Internal cross-file imports are relative with `.js` extension**
  because the package compiles to ESM under `NodeNext`
  (`import { runCli } from "./main.js"`). Do not use extensionless
  relative imports.
- **Workspace packages are imported by package name**
  (`@chengchenccc/message`, `@chengchenccc/ai`, `@chengchenccc/sandbox`, ...).
  Never use monorepo paths like `../../packages/...`.
- Example cross-file doc entry point to read first:
  [docs/architecture/index.llm.md](../../docs/architecture/index.llm.md).

## Rules and invariants

- `backend` is the source of truth for product state; `oma` is the runtime
  only. RPC mode must never write product DB.
- In `rpc` mode, **stdout is protocol-only** JSONL. No logs or debug text on
  stdout; logs go to stderr.
- Tool filtering happens at the final tool table (native + MCP + plugins)
  in run-runtime. The model never sees a filtered tool.
- Product-injected tools mount via MCP and take priority over native tools
  (e.g. MCP `todo_write` suppresses native todo).
- Plugin hooks receive a `runtime` (rt) parameter with stream/model/store
  abilities — no `pi`/jiti dynamic loading.
- `RunRuntimeDeps` carries env/test knobs; backend forwards
  `OMA_FAKE_*` through the adapter for in-process smoke tests.

## Known pitfalls

- **Bun timers in `Promise.race` must be cleared** or the process lingers
  after the race settles (15s hang).
- **Bun.spawn throws ENOENT on a missing cwd.**
- **RPC acceptance ordering:** record `execute` finished BEFORE responding
  success; the reader must not await the full run outcome or steer/abort
  never arrive.
- **`StdioClientTransport` does not inherit process env.** Custom test knobs
  (`MCP_ECHO_*`) must travel via `.mcp.json` `env`, not via the parent
  process environment.
- **read_image sandbox escape** is still an open issue — do not regress it.
- **Default model must come from the run's model binding** (`run model`),
  not `catalog[0]`. Budget + summarizer bind to the run model.

## Related docs

- [docs/architecture/index.llm.md](../../docs/architecture/index.llm.md) — repo doc hub
- [docs/architecture/oma.md](../../docs/architecture/oma.md)
- [docs/architecture/runtime/compaction.md](../../docs/architecture/runtime/compaction.md)
- [docs/architecture/plugins/oma-plugins.md](../../docs/architecture/plugins/oma-plugins.md)
- [docs/architecture/backend/overview.md](../../docs/architecture/backend/overview.md)

## Review checklist

1. `bun run typecheck` passes.
2. `bun run lint` passes.
3. `bun run test` passes.
4. RPC stdout remains protocol-only; no stray `console.log`.
5. Changes don't touch the backend DB or product truth.
