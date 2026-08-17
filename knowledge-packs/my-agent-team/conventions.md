# Conventions

## Imports

Cross-package imports MUST go through the barrel index.ts.
No deep imports like @my-agent-team/loop/src/loop-reducer.js.

## Dependency injection

Backend uses composition-root DI without a framework. Every feature follows the
hexagonal split (domain / ports / service / adapter-sqlite / http / index).

## Agent session creation

buildSessionSpec(params) assembles a SessionSpec:

- agentId
- cwd (tool sandbox root)
- model + modelName
- plugins
- tools (read/write/edit/bash/glob/grep by default)
- messageStore, eventLog, interruptStore
- contextManager

Use createAgentSession() (SDK entry point) or sessionFactory.getOrCreate().

## Plugin system

Plugins contribute tools and hooks. Six lifecycle points fire in registration order:

- beforeRun(ctx, messages) -> Message[]
- beforeModel(ctx, messages) -> Message[]
- afterModel(ctx, messages) -> void
- beforeTool(ctx, call, messages) -> skip/input/result
- afterTool(ctx, call, result, messages) -> void
- beforeStop(ctx, messages) -> StopDecision

Use definePlugin({ name, hooks, tools }). validatePlugins() checks tool name collisions.

## ChatModel contract

Core has no LLM dependency. ChatModel.stream(messages, opts?) is the contract.
Tests use echoModel() from @my-agent-team/test-helpers.

## File naming

Source: *.ts, tests: *.test.ts beside source (no __tests__ dirs).
Features use domain.ts, ports.ts, service.ts, adapter-sqlite.ts, http.ts, index.ts.

## Error handling

- Backend: Elysia onError maps DomainError subclasses to JSON.
- Service layer throws typed errors (ProjectNotFoundError, ValidationError).
- Loop: errors catch and retry with backoff in scheduler fireLoop().
- Agent: InterruptSignal from tool execute pauses the agent for human approval.

## Commit rules

- Conventional commits with a mandatory scope from commitlint.config.mjs.
- No CJK anywhere in commit messages.
- Body lines max 100 chars.
- Husky pre-commit runs biome format + check over the repo.
