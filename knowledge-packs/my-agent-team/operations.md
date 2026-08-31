# Operations

## Commands

- bun install: install dependencies
- bun run build: build all packages (turbo)
- bun run dev: start dev servers
- bun run format: biome format all files
- bun run lint: biome check + eslint
- bun run typecheck: tsc --noEmit across packages
- bun test: run tests at repo root

Scoped examples:

- cd apps/oh-my-agent && bun test --test-name-pattern="agent-loop"
- cd apps/backend && bun run typecheck
- cd apps/backend && bun test tests/e2e/mcp-crud.test.ts

## Testing model doubles

- echoModel() from @chengchenccc/test-helpers: deterministic scripted ChatModel
- createInMemorySessionStore() from apps/oh-my-agent/src/core/persistence (session store double)
- Workflow tests: packages/workflow engine/parse/schema + apps/backend features/workflow service/trigger-scheduler tests

## Resource switching

- MCP: /team/mcp global catalog; agent MCP tab toggles enabled servers
- Knowledge: /team/knowledge install pool; agent Knowledge tab toggles packs
- Skills: /team/skills install pool; agent Skills tab toggles packs
- Agent enabled: top-level kill switch in the agent config bar

## Backend data layout

- <dataDir>/backend.db: SQLite database
- <dataDir>/agents/<id>/: agent workspaces with agent.yml
- <dataDir>/skill-packs/<id>/: installed skill packs
- <dataDir>/knowledge/<id>/: installed knowledge packs
- <dataDir>/mcp-servers.json: global MCP catalog

## Debugging

- OMA_DEBUG=1 emits the run lifecycle chain to stderr (no message content)
- Bun timers in Promise.race must be cleared or the process lingers
- Bun.spawn throws ENOENT on a missing cwd
- StdioClientTransport does not inherit custom parent env vars; pass config in-band
