# Architecture

## Backend hexagonal layout

Every backend feature follows the same file split:

- domain.ts: pure types and entity interfaces
- ports.ts: storage boundary interface
- service.ts: business logic via factory createXxxService(deps)
- adapter-sqlite.ts: Drizzle ORM implementation
- http.ts: Elysia routes
- index.ts: barrel re-exports

Composition root is apps/backend/src/main.ts; it creates adapters, injects them
into service factories, then mounts HTTP routes in app.ts.

## Agent run path

- Conversation service enqueues an input for a target agent member.
- AgentRunService.enqueueAndAcquire is the single run-creation choke point.
  It resolves the frozen run config (system prompt, skill roots, permission mode)
  and persists the input atomically.
- AgentRunExecutionService.dispatch spawns the per-backend child process.
- coding-agent runs one process per turn and speaks stdio JSONL over RPC.
- BackendRunOutcome is the only terminal authority; events are observational.

## Workspace bridge

reconcileAgentResources writes per-agent workspace config:

- .mcp.json: enabled MCP servers + product-tools + knowledge recall server
- .agent/product-tools.json: product tool manifest for coding-agent
- <kind>/skills symlinks: assigned skill packs
- knowledge/ symlinks + index.md: assigned knowledge packs
- .claude/settings.json: pre-allowed product tools for claude backend

## File-first config

agent.yml is the single source for agent config (ADR 0020). The DB holds only
the agent anchor row plus a materialized cache. Runtime_config carries:

- runtime backend kind
- model_id
- reasoning_effort
- permission_mode
- max_steps
- mcp_servers (server_id + enabled)
- knowledge_packs
- projects
- top-level enabled kill switch

## Knowledge recall

The knowledge MCP server is a stdio server scoped to the agent workspace
knowledge dir. Assigned packs are symlinked into the workspace; the server is
launched with --allowed-pack <installRoot> for each pack so search can follow
the symlink while still rejecting arbitrary escapes.

## Loop system

Two layers:

- packages/loop: pure reducer over STATE.md / INBOX.md / LOOP.md with YAML frontmatter
- apps/backend loop orchestration: AgentSession dispatch, git rollback, budget tracking

loopStep() runs Generator AgentSession -> Evaluator AgentSession -> verdict -> writeback.
A per-loop promise-chain write lock serializes cron + manual + review entry points.
