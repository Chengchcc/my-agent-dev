# Agentic Loop Design Specification

## Overview

This specification describes the implementation of a fully autonomous agentic loop that repeatedly calls the LLM, executes tool calls, and feeds results back to the LLM until the model produces a final text-only response.

## Motivation

The current implementation only makes a single LLM invocation. When the model returns `tool_calls`, those calls are stored in context but **never executed**. This leaves the registered tools (BashTool, TextEditorTool, ZodTool) as unused decorations. The agent cannot autonomously complete multi-step tasks that require tool usage.

## Goals

- Add fully autonomous agentic loop with tool execution
- Maintain backward compatibility: existing `run()` / `runStream()` APIs remain unchanged
- Provide a unified event stream for observable execution (good for UI)
- Support proper cancellation: abort kills running subprocesses
- Follow existing project patterns but improve organization

## Non-Goals

- Changing existing Provider / Middleware / AgentHooks interfaces is not required
- Changing the ContextManager compression strategy is out of scope
- Full unit test coverage is P1 (not required for P0)

## Architecture

### Directory Structure

After refactoring:

```
src/
├── types.ts                     # Global shared types (Message, ToolCall, Provider, Middleware, etc.)
│
├── agent/                       # Agent core module - everything for the agentic loop in one place
│   ├── index.ts                 # Unified exports
│   ├── Agent.ts                 # Agent class with run(), runStream(), runAgentLoop()
│   ├── loop-types.ts            # AgentEvent, AgentLoopConfig, AggregatedUsage
│   ├── context.ts               # ContextManager + compression strategies
│   ├── middleware.ts            # composeMiddlewares utility
│   └── tool-registry.ts         # ToolRegistry - manages tool registration/lookup
│
├── providers/                   # LLM Provider implementations (flattened from foundation/)
│   ├── index.ts
│   ├── claude.ts
│   └── openai.ts
│
├── tools/                       # Built-in tool implementations
│   ├── index.ts
│   ├── bash.ts
│   ├── text-editor.ts
│   └── zod-tool.ts
│
├── skills/                      # Skill loading and injection
│   ├── index.ts
│   ├── loader.ts
│   └── middleware.ts
│
├── cli/                         # Terminal UI
│   └── tui/
│       ├── components/
│       │   └── ToolCallMessage.tsx    # New: displays tool call execution status
│       └── hooks/
│           └── use-agent-loop.tsx      # Updated: consumes AgentEvent stream
```

### Key Components

#### 1. `AgentEvent` (loop-types.ts)

Union of all possible events yielded by `runAgentLoop()`:

| Event Type | Purpose | Timing |
|------------|---------|--------|
| `text_delta` | Incremental text streaming from LLM | During LLM streaming |
| `tool_call_start` | Tool execution about to start | **Before** execution (UI can show spinner) |
| `tool_call_result` | Tool execution completed | After execution finishes |
| `turn_complete` | One full LLM invocation completed | After LLM + any tool execution |
| `agent_done` | Full agent execution completed | Final event |
| `agent_error` | Error occurred during execution | When error is encountered |

#### 2. `AgentLoopConfig` (loop-types.ts)

Configuration for loop behavior and limits:

```typescript
interface AgentLoopConfig {
  maxTurns: number;                    // default: 25
  timeoutMs: number;                   // default: 10 minutes (entire run)
  toolTimeoutMs: number;               // default: 2 minutes (single tool)
  maxToolOutputChars: number;          // default: 100KB (truncate after this)
  parallelToolExecution: boolean;      // default: true (multiple tools in one turn)
  yieldEventsAsToolsComplete: boolean;  // default: true (yield early when using parallel)
  toolErrorStrategy: 'continue' | 'halt'; // default: 'continue'
}
```

#### 3. `ToolRegistry` (tool-registry.ts)

Central registry that maps tool names to implementations:

```typescript
class ToolRegistry {
  register(tool: ToolImplementation): void;
  unregister(name: string): boolean;
  get(name: string): ToolImplementation | undefined;
  has(name: string): boolean;
  getAllDefinitions(): Tool[]; // for provider registration
  clear(): void;
  size(): number;
}
```

#### 4. `Agent` Class Changes (`agent/Agent.ts`)

- Add optional `toolRegistry` constructor parameter
- In constructor: if toolRegistry provided, automatically register all tool definitions with provider
- Add `async *runAgentLoop(userMessage, config?): AsyncGenerator<AgentEvent>` method
- Keep existing `run()` / `runStream()` unchanged

#### 5. `BashTool` Changes (`tools/bash.ts`)

- Add optional `signal: AbortSignal` parameter to `execute()`
- When signal aborts, kill the child process and return error result
- Proper cleanup handles agent abortion during tool execution

#### 6. `ToolCallMessage` TUI Component (`cli/tui/components/ToolCallMessage.tsx`)

- New React component for displaying tool execution status in chat history
- Shows spinner when running, checkmark when done, error indicator on failure
- Collapsible for large tool outputs

#### 7. `use-agent-loop` Hook Changes (`cli/tui/hooks/use-agent-loop.tsx`)

- Update `onSubmit` to consume `AgentEvent` stream from `runAgentLoop()`
- Handle each event type to update UI state:
  - `text_delta`: accumulate streaming content
  - `tool_call_start`: add tool to UI with running status
  - `tool_call_result`: update tool with result
  - `agent_done`: sync with agent context, update messages

## Execution Flow

```
User Input → runAgentLoop():
  1. Add user message to context
  2. Run beforeAgentRun hooks
  3. Initialize timeout
  4. LOOP (while turnIndex < maxTurns and not done):
     a. Compress context via compressIfNeeded() (every turn)
     b. Run beforeCompress + beforeModel hooks
     c. Stream from LLM → yield text_delta events
     d. Run afterModel hooks
     e. Save assistant message to context (includes text + tool_calls if any)
     f. If NO tool_calls → break (done)
     g. yield turn_complete event
     h. For each tool_call:
        i. yield tool_call_start (before execution)
        ii. Lookup tool in registry, execute with timeout + signal
        iii. yield tool_call_result (after execution)
        iv. Add tool result message to context
     i. End For
  5. END LOOP
  6. Run afterAgentRun hooks
  7. yield agent_done
```

## Key Design Decisions

1. **tool_call_start before execution** → UI gets immediate feedback, can show loading state
2. **Yield events as they complete in parallel** → more responsive UI
3. **Compress before every turn** → prevents context bloat over multiple tool turns
4. **Configurable error strategy** → caller can choose between continue/halt
5. **AbortSignal propagation to BashTool** → clean process killing on abort
6. **Backward compatible** → existing code doesn't break

## Backward Compatibility

- All existing public APIs remain unchanged
- `toolRegistry` is optional in Agent constructor → existing usage continues to work
- New `runAgentLoop()` is additive → no breaking changes
- Provider interface unchanged → existing Claude/OpenAI implementations work as-is

## Security Considerations

- Existing working directory restrictions in BashTool remain in place
- Tool output truncation prevents excessive context bloat
- Max turns limit prevents infinite loops

## Success Criteria (P0)

- [ ] Directory restructure complete
- [ ] `ToolRegistry` implemented
- [ ] `AgentEvent` types defined
- [ ] `runAgentLoop()` implemented in Agent class with proper event yielding
- [ ] `BashTool` updated with AbortSignal support
- [ ] TUI updated to use `runAgentLoop()` with proper tool display
- [ ] TypeScript compiles without errors
- [ ] End-to-end works: LLM → tool execution → LLM response flow in TUI
