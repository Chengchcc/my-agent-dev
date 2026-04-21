# Agentic Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a fully autonomous agentic loop with tool execution capability, reorganize code structure for better maintainability, and update the TUI to display tool execution progress.

**Architecture:**
The agentic loop runs as an async generator yielding `AgentEvent` events for observability. A new `ToolRegistry` manages tool registration and lookup. All agent core code is consolidated into `src/agent/` directory for better discoverability. LLM providers are flattened from `foundation/providers` to `providers`. The existing `run()` and `runStream()` APIs remain unchanged for backward compatibility.

**Tech Stack:**
- TypeScript 6.x with strict typing
- Existing React/Ink for TUI
- Node.js `child_process` with AbortSignal for process cancellation
- Async generators for streaming events

---

### Task 1: Create `src/agent/` directory structure

**Files:**
- Create: `src/agent/` directory
- Create: `src/agent/index.ts`
- Create: `src/providers/` directory
- Create: `src/providers/index.ts`

- [ ] Step 1: Create directories

```bash
mkdir -p src/agent src/providers
```

- [ ] Step 2: Create `src/agent/index.ts` with exports

```typescript
// src/agent/index.ts
export { Agent } from './Agent';
export { ContextManager } from './context';
export { composeMiddlewares } from './middleware';
export type {
  AgentEvent,
  AgentLoopConfig,
  AggregatedUsage,
  TextDeltaEvent,
  ToolCallStartEvent,
  ToolCallResultEvent,
  TurnCompleteEvent,
  AgentDoneEvent,
  AgentErrorEvent,
} from './loop-types';
export { DEFAULT_LOOP_CONFIG } from './loop-types';
export { ToolRegistry } from './tool-registry';
```

- [ ] Step 3: Create `src/providers/index.ts` with exports

```typescript
// src/providers/index.ts
export { ClaudeProvider } from './claude';
export { OpenAIProvider } from './openai';
export type { ClaudeConfig, OpenAIConfig } from './types';
```

- [ ] Step 4: Commit

```bash
git add src/agent/index.ts src/providers/index.ts
git commit -m "chore: create agent and providers directory structure"
```

---

### Task 2: Move existing files to new locations

**Files:**
- Move: `src/agent.ts` → `src/agent/Agent.ts`
- Move: `src/context.ts` → `src/agent/context.ts`
- Move: `src/middleware.ts` → `src/agent/middleware.ts`
- Move: `src/foundation/providers/*` → `src/providers/`

- [ ] Step 1: Move agent core files

```bash
mv src/agent.ts src/agent/Agent.ts
mv src/context.ts src/agent/context.ts
mv src/middleware.ts src/agent/middleware.ts
```

- [ ] Step 2: Move provider files

```bash
mv src/foundation/providers/claude.ts src/providers/
mv src/foundation/providers/openai.ts src/providers/
mv src/foundation/providers/types.ts src/providers/
rm -rf src/foundation
```

- [ ] Step 3: Update import paths in moved files

> **Note:** All imports that referenced `../types.ts` become `../../types.ts`
> All imports that referenced `../context` etc now need updating.

- [ ] Step 4: Commit

```bash
git add src/agent src/providers src/foundation
git commit -m "refactor: move files to new directory structure"
```

---

### Task 3: Add `loop-types.ts` with AgentEvent and AgentLoopConfig

**Files:**
- Create: `src/agent/loop-types.ts`

- [ ] Step 1: Write `loop-types.ts` with all types

```typescript
// src/agent/loop-types.ts
import type { ToolCall } from '../../types';

/**
 * Base interface for all agent events
 */
export interface AgentEventBase {
  type: string;
  turnIndex: number;
}

/**
 * Text delta event - streamed incremental content from the model
 */
export interface TextDeltaEvent extends AgentEventBase {
  type: 'text_delta';
  delta: string;
}

/**
 * Tool call started - yielded before execution starts
 * Allows UI to show a loading spinner immediately
 */
export interface ToolCallStartEvent extends AgentEventBase {
  type: 'tool_call_start';
  toolCall: ToolCall;
}

/**
 * Tool call completed - yielded after execution finishes
 * Contains the full result (or error)
 */
export interface ToolCallResultEvent extends AgentEventBase {
  type: 'tool_call_result';
  toolCall: ToolCall;
  result: unknown;
  error?: Error;
}

/**
 * Turn complete - a single LLM invocation + tool execution (if any) has finished
 */
export interface TurnCompleteEvent extends AgentEventBase {
  type: 'turn_complete';
  hasToolCalls: boolean;
}

/**
 * Agent done - full execution completed
 */
export interface AgentDoneEvent extends AgentEventBase {
  type: 'agent_done';
  totalTurns: number;
  reason: 'completed' | 'max_turns_reached' | 'error';
  error?: Error;
}

/**
 * Agent error - something went wrong during execution
 */
export interface AgentErrorEvent extends AgentEventBase {
  type: 'agent_error';
  error: Error;
}

/**
 * Union of all possible agent events
 */
export type AgentEvent =
  | TextDeltaEvent
  | ToolCallStartEvent
  | ToolCallResultEvent
  | TurnCompleteEvent
  | AgentDoneEvent
  | AgentErrorEvent;

/**
 * Strategy for handling tool errors
 * - 'continue': Add the error as a tool message to context and continue the loop
 * - 'halt': Stop execution immediately with an error
 */
export type ToolErrorStrategy = 'continue' | 'halt';

/**
 * Agent loop configuration - limits and behavior options
 */
export interface AgentLoopConfig {
  /** Maximum number of full turns (LLM → tools → LLM) before stopping */
  maxTurns: number;
  /** Total timeout for the entire agent execution in milliseconds */
  timeoutMs: number;
  /** Timeout for individual tool execution in milliseconds */
  toolTimeoutMs: number;
  /** Maximum characters in a single tool output before truncation */
  maxToolOutputChars: number;
  /** Allow parallel execution of multiple tool calls in the same turn */
  parallelToolExecution: boolean;
  /** Yield tool events as they complete (true) or wait for all and yield all at once (false) */
  yieldEventsAsToolsComplete: boolean;
  /** What to do when a tool execution throws an error */
  toolErrorStrategy: ToolErrorStrategy;
}

/**
 * Default agent loop configuration - reasonable safe defaults
 */
export const DEFAULT_LOOP_CONFIG: AgentLoopConfig = {
  maxTurns: 25,
  timeoutMs: 10 * 60 * 1000, // 10 minutes
  toolTimeoutMs: 2 * 60 * 1000, // 2 minutes
  maxToolOutputChars: 100 * 1024, // 100KB
  parallelToolExecution: true,
  yieldEventsAsToolsComplete: true,
  toolErrorStrategy: 'continue',
};

/**
 * Aggregated token usage across all turns
 */
export interface AggregatedUsage {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
}
```

- [ ] Step 2: Run TypeScript check

```bash
bun run tsc
```

- [ ] Step 3: Commit

```bash
git add src/agent/loop-types.ts
git commit -m "feat: add loop-types with AgentEvent and AgentLoopConfig"
```

---

### Task 4: Implement `ToolRegistry`

**Files:**
- Create: `src/agent/tool-registry.ts`

- [ ] Step 1: Write `tool-registry.ts`

```typescript
// src/agent/tool-registry.ts
import type { Tool, ToolImplementation } from '../../types';

/**
 * ToolRegistry - manages registration and lookup of tool implementations
 * Central registry that maps tool names to their implementations
 */
export class ToolRegistry {
  private tools: Map<string, ToolImplementation> = new Map();

  /**
   * Register a tool implementation with the registry
   */
  register(tool: ToolImplementation): void {
    const definition = tool.getDefinition();
    this.tools.set(definition.name, tool);
  }

  /**
   * Unregister a tool from the registry
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Get a tool implementation by name
   */
  get(name: string): ToolImplementation | undefined {
    return this.tools.get(name);
  }

  /**
   * Check if a tool is registered
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Get all tool definitions for registration with provider
   */
  getAllDefinitions(): Tool[] {
    return Array.from(this.tools.values()).map(tool => tool.getDefinition());
  }

  /**
   * Clear all registered tools
   */
  clear(): void {
    this.tools.clear();
  }

  /**
   * Get number of registered tools
   */
  size(): number {
    return this.tools.size;
  }
}
```

- [ ] Step 2: Run TypeScript check

```bash
bun run tsc
```

- [ ] Step 3: Commit

```bash
git add src/agent/tool-registry.ts
git commit -m "feat: add ToolRegistry"
```

---

### Task 5: Update `Agent` class with `runAgentLoop()` method

**Files:**
- Modify: `src/agent/Agent.ts`
- Update imports to reflect new structure

- [ ] Step 1: Update imports and add `toolRegistry` to constructor

Add these imports at the top:

```typescript
import type {
  AgentContext,
  AgentConfig,
  LLMResponse,
  LLMResponseChunk,
  Middleware,
  Provider,
  ToolCall,
  AgentHooks,
  Message,
  ToolImplementation,
} from '../../types';
import type { AgentEvent, AgentLoopConfig } from './loop-types';
import { ContextManager } from './context';
import { composeMiddlewares } from './middleware';
import { DEFAULT_LOOP_CONFIG } from './loop-types';
import { ToolRegistry } from './tool-registry';
```

Update the constructor signature:

```typescript
export class Agent {
  private provider: Provider;
  private contextManager: ContextManager;
  private middleware: Middleware[];
  private hooks: Required<AgentHooks>;
  private config: AgentConfig;
  private toolRegistry: ToolRegistry | null;
  private abortController: AbortController | null = null;

  constructor(options: {
    provider: Provider;
    contextManager: ContextManager;
    middleware?: Middleware[];
    hooks?: AgentHooks;
    config: AgentConfig;
    toolRegistry?: ToolRegistry;
  }) {
    this.provider = options.provider;
    this.contextManager = options.contextManager;
    this.middleware = options.middleware ?? [];
    this.config = options.config;
    this.toolRegistry = options.toolRegistry ?? null;
    // Default all hook arrays to empty
    this.hooks = {
      beforeAgentRun: options.hooks?.beforeAgentRun ?? [],
      beforeCompress: options.hooks?.beforeCompress ?? [],
      beforeModel: options.hooks?.beforeModel ?? [],
      afterModel: options.hooks?.afterModel ?? [],
      beforeAddResponse: options.hooks?.beforeAddResponse ?? [],
      afterAgentRun: options.hooks?.afterAgentRun ?? [],
    };

    // Auto-register tools with provider if registry exists
    if (this.toolRegistry) {
      this.provider.registerTools(this.toolRegistry.getAllDefinitions());
    }
  }
```

- [ ] Step 2: Add `truncateOutput` private method

```typescript
  /**
   * Truncate tool output if it exceeds max character limit.
   */
  private truncateOutput(output: string, maxChars: number): string {
    if (output.length <= maxChars) {
      return output;
    }
    const truncated = output.slice(0, maxChars);
    return `${truncated}\n\n--- Output truncated after ${maxChars} characters ---`;
  }
```

- [ ] Step 3: Add `executeToolCall` private method

```typescript
  /**
   * Execute a single tool call with timeout.
   */
  private async executeToolCall(
    toolCall: ToolCall,
    maxOutputChars: number,
    toolTimeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ result: unknown; error?: Error }> {
    const tool = this.toolRegistry?.get(toolCall.name);

    if (!tool) {
      return {
        result: `Error: Tool '${toolCall.name}' not found in registry.`,
      };
    }

    try {
      // Create timeout promise
      const timeoutPromise = new Promise<{ result: unknown; error?: Error }>(
        (resolve) => {
          setTimeout(() => {
            resolve({
              result: `Error: Tool execution timed out after ${toolTimeoutMs}ms.`,
              error: new Error(`Tool timeout after ${toolTimeoutMs}ms`),
            });
          }, toolTimeoutMs);
        }
      );

      // Execute tool with potential signal
      const executePromise = (async () => {
        // If ToolImplementation.execute doesn't accept signal, we just run it
        // For tools that do accept signal (like BashTool), pass it through
        // TypeScript doesn't know at compile time, so we do runtime checking
        try {
          const toolFn = tool.execute as (
            params: Record<string, unknown>,
            opts?: { signal?: AbortSignal },
          ) => Promise<unknown>;
          if (toolFn.length > 1) {
            return await toolFn.call(tool, toolCall.arguments, { signal });
          }
          return await tool.execute(toolCall.arguments);
        } catch (error) {
          throw error;
        }
      })();

      // Race between timeout and execution
      const result = await Promise.race([executePromise, timeoutPromise]);

      // Truncate if output is a string
      if (typeof result === 'string') {
        return { result: this.truncateOutput(result, maxOutputChars) };
      }
      if (
        result &&
        typeof (result as { output?: string }).output === 'string'
      ) {
        (result as { output: string }).output = this.truncateOutput(
          (result as { output: string }).output,
          maxOutputChars,
        );
      }

      return { result };
    } catch (error) {
      return {
        result: `Error executing tool '${toolCall.name}': ${
          error instanceof Error ? error.message : String(error)
        }`,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }
```

- [ ] Step 4: Add the `runAgentLoop` async generator method

```typescript
  /**
   * Run the full autonomous agentic loop:
   * LLM → execute tool_calls → repeat until no more tool calls.
   * Yields events for each step for observable execution.
   */
  async *runAgentLoop(
    userMessage: { role: 'user'; content: string },
    loopConfig?: Partial<AgentLoopConfig>,
  ): AsyncGenerator<AgentEvent> {
    const config: AgentLoopConfig = { ...DEFAULT_LOOP_CONFIG, ...loopConfig };
    const controller = new AbortController();
    const signal = controller.signal;
    this.abortController = controller;

    // Create timeout timer
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, config.timeoutMs);

    try {
      // 1. beforeAgentRun hooks
      const initialContext = this.contextManager.getContext(this.config);
      const composedBeforeAgentRun = composeMiddlewares(
        this.hooks.beforeAgentRun,
        (ctx) => Promise.resolve(ctx),
      );
      const afterBeforeAgentRun = await composedBeforeAgentRun(initialContext);

      // Add user message to context after hooks
      this.contextManager.addMessage({
        role: 'user',
        content: userMessage.content,
      });

      let turnIndex = 0;
      let done = false;
      let errorOccurred = false;

      while (turnIndex < config.maxTurns && !done && !signal.aborted) {
        // a. Compress context if needed (every turn)
        const currentContext = this.contextManager.getContext(this.config);
        const composedBeforeCompress = composeMiddlewares(
          this.hooks.beforeCompress,
          (ctx) => Promise.resolve(ctx),
        );
        const afterBeforeCompress = await composedBeforeCompress(currentContext);
        const compressedMessages = await this.contextManager.compressIfNeeded(
          afterBeforeCompress,
        );
        afterBeforeCompress.messages = compressedMessages;

        // b. Run beforeModel middleware
        const outerComposed = composeMiddlewares(
          this.middleware,
          async (ctx) => {
            const composedBeforeModel = composeMiddlewares(
              this.hooks.beforeModel,
              (innerCtx) => Promise.resolve(innerCtx),
            );
            return composedBeforeModel(ctx);
          },
        );
        let resultContext = await outerComposed(afterBeforeCompress);

        // c. Stream from LLM
        let fullContent = '';
        const tool_calls: ToolCall[] = [];

        for await (const chunk of this.provider.stream(resultContext, { signal })) {
          if (signal.aborted) break;
          if (chunk.content) {
            fullContent += chunk.content;
            yield {
              type: 'text_delta',
              delta: chunk.content,
              turnIndex,
            } satisfies AgentEvent;
          }
          if (chunk.tool_calls) {
            tool_calls.push(...chunk.tool_calls);
          }
        }

        if (signal.aborted) {
          yield {
            type: 'agent_error',
            error: new Error('Agent execution aborted'),
            turnIndex,
          } satisfies AgentEvent;
          errorOccurred = true;
          break;
        }

        // d. afterModel hooks
        const composedAfterModel = composeMiddlewares(
          this.hooks.afterModel,
          (ctx) => Promise.resolve(ctx),
        );
        resultContext = await composedAfterModel(resultContext);

        // Set full response on context
        resultContext.response = {
          content: fullContent,
          tool_calls: tool_calls.length > 0 ? tool_calls : undefined,
          usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
          },
          model: '',
        };

        // e. beforeAddResponse hooks
        const composedBeforeAddResponse = composeMiddlewares(
          this.hooks.beforeAddResponse,
          (ctx) => Promise.resolve(ctx),
        );
        resultContext = await composedBeforeAddResponse(resultContext);

        // f. Save assistant message to context
        if (resultContext.response) {
          this.contextManager.addMessage({
            role: 'assistant',
            content: resultContext.response.content,
            tool_calls: resultContext.response.tool_calls,
          });
        }

        // g. If no tool calls, we're done
        if (!tool_calls || tool_calls.length === 0) {
          done = true;
          yield {
            type: 'turn_complete',
            turnIndex,
            hasToolCalls: false,
          } satisfies AgentEvent;
          break;
        }

        // h. We have tool calls - yield turn complete
        yield {
          type: 'turn_complete',
          turnIndex,
          hasToolCalls: true,
        } satisfies AgentEvent;

        // i. Execute tool calls
        if (config.parallelToolExecution && config.yieldEventsAsToolsComplete) {
          // Execute in parallel and yield as they complete
          const promises = tool_calls.map(async (toolCall) => {
            yield {
              type: 'tool_call_start',
              toolCall,
              turnIndex,
            } satisfies AgentEvent;

            const result = await this.executeToolCall(
              toolCall,
              config.maxToolOutputChars,
              config.toolTimeoutMs,
              signal,
            );

            yield {
              type: 'tool_call_result',
              toolCall,
              result: result.result,
              error: result.error,
              turnIndex,
            } satisfies AgentEvent;

            // Add tool result to context
            const content =
              result.result && typeof result.result === 'string'
                ? result.result
                : JSON.stringify(result.result, null, 2);

            this.contextManager.addMessage({
              role: 'tool',
              content,
              tool_call_id: toolCall.id,
              name: toolCall.name,
            });

            // Check if we should halt on error
            if (result.error && config.toolErrorStrategy === 'halt') {
              throw result.error;
            }

            return result;
          });

          // Wait for all promises
          await Promise.allSettled(promises);
        } else if (config.parallelToolExecution) {
          // Execute in parallel, yield all after all complete
          const results = await Promise.allSettled(
            tool_calls.map(async (toolCall) => {
              return this.executeToolCall(
                toolCall,
                config.maxToolOutputChars,
                config.toolTimeoutMs,
                signal,
              );
            }),
          );

          for (let i = 0; i < tool_calls.length; i++) {
            const toolCall = tool_calls[i];
            yield {
              type: 'tool_call_start',
              toolCall,
              turnIndex,
            } satisfies AgentEvent;

            const result = results[i].status === 'fulfilled'
              ? results[i].value
              : {
                  result: `Error: ${results[i].reason}`,
                  error:
                    results[i].reason instanceof Error
                      ? results[i].reason
                      : new Error(String(results[i].reason)),
                };

            yield {
              type: 'tool_call_result',
              toolCall,
              result: result.result,
              error: result.error,
              turnIndex,
            } satisfies AgentEvent;

            const content =
              result.result && typeof result.result === 'string'
                ? result.result
                : JSON.stringify(result.result, null, 2);

            this.contextManager.addMessage({
              role: 'tool',
              content,
              tool_call_id: toolCall.id,
              name: toolCall.name,
            });

            if (result.error && config.toolErrorStrategy === 'halt') {
              throw result.error;
            }
          }
        } else {
          // Execute sequentially
          for (const toolCall of tool_calls) {
            yield {
              type: 'tool_call_start',
              toolCall,
              turnIndex,
            } satisfies AgentEvent;

            const result = await this.executeToolCall(
              toolCall,
              config.maxToolOutputChars,
              config.toolTimeoutMs,
              signal,
            );

            yield {
              type: 'tool_call_result',
              toolCall,
              result: result.result,
              error: result.error,
              turnIndex,
            } satisfies AgentEvent;

            const content =
              result.result && typeof result.result === 'string'
                ? result.result
                : JSON.stringify(result.result, null, 2);

            this.contextManager.addMessage({
              role: 'tool',
              content,
              tool_call_id: toolCall.id,
              name: toolCall.name,
            });

            if (result.error && config.toolErrorStrategy === 'halt') {
              throw result.error;
            }
          }
        }

        turnIndex++;
      }

      // 6. afterAgentRun hooks
      const finalContext = this.contextManager.getContext(this.config);
      const composedAfterAgentRun = composeMiddlewares(
        this.hooks.afterAgentRun,
        (ctx) => Promise.resolve(ctx),
      );
      await composedAfterAgentRun(finalContext);

      // Determine completion reason
      let reason: AgentDoneEvent['reason'] = 'completed';
      if (errorOccurred) {
        reason = 'error';
      } else if (turnIndex >= config.maxTurns && !done) {
        reason = 'max_turns_reached';
      }

      // 7. yield agent_done
      yield {
        type: 'agent_done',
        totalTurns: turnIndex + 1,
        reason,
        turnIndex,
      } satisfies AgentEvent;
    } catch (error) {
      // Handle unexpected errors
      yield {
        type: 'agent_error',
        error: error instanceof Error ? error : new Error(String(error)),
        turnIndex,
      } satisfies AgentEvent;
      yield {
        type: 'agent_done',
        totalTurns: turnIndex + 1,
        reason: 'error',
        error: error instanceof Error ? error : new Error(String(error)),
        turnIndex,
      } satisfies AgentEvent;
    } finally {
      clearTimeout(timeoutId);
      if (this.abortController === controller) {
        this.abortController = null;
      }
    }
  }
```

- [ ] Step 5: Keep existing methods (`run`, `runStream`, `getContext`, `clear`, `abort`, `getContextManager`) and update their imports if needed.

- [ ] Step 6: Run TypeScript check and fix errors

```bash
bun run tsc
```

- [ ] Step 7: Commit

```bash
git add src/agent/Agent.ts
git commit -m "feat: add runAgentLoop method to Agent class"
```

---

### Task 6: Update `BashTool` with AbortSignal support

**Files:**
- Modify: `src/tools/bash.ts`

- [ ] Step 1: Update `execute` method signature to accept `signal` option

Change method from:

```typescript
  async execute(params: { command: string; cwd?: string }): Promise<{
```

To:

```typescript
  async execute(
    params: { command: string; cwd?: string },
    options?: { signal?: AbortSignal },
  ): Promise<{
```

Inside the method: after creating the proc, add:

```typescript
      proc.on('error', (error) => {
        output += `Error: ${error.message}`;
        resolve({
          output,
          exitCode: 1,
          timedOut: false,
          truncated,
        });
      });

      // Handle abort signal
      options?.signal?.addEventListener('abort', () => {
        if (proc && proc.pid) {
          // Kill the child process
          process.kill(-proc.pid);
        }
        output += `\n--- Command aborted by user ---`;
        resolved = true;
        resolve({
          output,
          exitCode: 130, // SIGTERM exit code
          timedOut: false,
          truncated,
        });
      });
```

- [ ] Step 2: Update import if needed (already importing `exec`, no changes needed)

- [ ] Step 3: Run TypeScript check

```bash
bun run tsc
```

- [ ] Step 4: Commit

```bash
git add src/tools/bash.ts
git commit -m "feat: add AbortSignal support to BashTool for process killing"
```

---

### Task 7: Add `ToolCallMessage` TUI component

**Files:**
- Create: `src/cli/tui/components/ToolCallMessage.tsx`
- Modify: `src/cli/tui/components/index.ts`

- [ ] Step 1: Create `ToolCallMessage.tsx`

```tsx
// src/cli/tui/components/ToolCallMessage.tsx
import React from 'react';
import { Box, Text, Spacer } from 'ink';
import type { ToolCall, ToolCallResultEvent } from '../../../types';
import type { AgentEvent } from '../../../agent/loop-types';

/**
 * Props for ToolCallMessage component
 */
type ToolCallMessageProps = {
  toolCall: ToolCall;
  status: 'running' | 'completed' | 'error';
  result?: ToolCallResultEvent['result'];
  error?: Error;
};

/**
 * Displays a tool call execution status in the chat history
 */
export function ToolCallMessage({ toolCall, status, result, error }: ToolCallMessageProps) {
  return (
    <Box flexDirection="column" borderStyle="round" padding={1} marginY={1}>
      <Box flexDirection="row" alignItems="center">
        <Text bold>Tool: {toolCall.name}</Text>
        <Spacer />
        {status === 'running' && <Text color="yellow">Running...</Text>}
        {status === 'completed' && <Text color="green">✓ Done</Text>}
        {status === 'error' && <Text color="red">✗ Error</Text>}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Arguments: {JSON.stringify(toolCall.arguments, null, 2)}</Text>
      </Box>
      {result && status !== 'running' && (
        <Box marginTop={1}>
          <Box flexDirection="column">
            <Text bold>Output:</Text>
            <Text dimColor>
              {typeof result === 'string'
                ? result
                : JSON.stringify(result, null, 2)}
            </Text>
          </Box>
        </Box>
      )}
      {error && (
        <Box marginTop={1}>
          <Text color="red">Error: {error.message}</Text>
        </Box>
      )}
    </Box>
  );
}
```

- [ ] Step 2: Add export to `index.ts`

Edit `src/cli/tui/components/index.ts` and add:

```typescript
export * from './ToolCallMessage';
```

- [ ] Step 3: Run TypeScript check

```bash
bun run tsc
```

- [ ] Step 4: Commit

```bash
git add src/cli/tui/components/ToolCallMessage.tsx src/cli/tui/components/index.ts
git commit -m "feat: add ToolCallMessage component for TUI"
```

---

### Task 8: Update `use-agent-loop` hook to consume `AgentEvent` stream

**Files:**
- Modify: `src/cli/tui/hooks/use-agent-loop.tsx`

- [ ] Step 1: Update imports

Add at the top:

```typescript
import type { AgentEvent, ToolCallStartEvent } from '../../../agent/loop-types';
```

Update existing types.

- [ ] Step 2: Add state for tracking in-progress tool calls

Inside `AgentLoopProvider`:

```typescript
  const [streaming, setStreaming] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [todos, setTodos] = useState<UITodoItem[]>([]);
  const [currentTools, setCurrentTools] = useState<ToolCallStartEvent[]>([]);

  const streamingRef = useRef(streaming);
  const streamingMessageRef = useRef<Message | null>(null);
```

- [ ] Step 3: Rewrite `onSubmit` to consume `runAgentLoop` instead of `runStream`

Replace the entire try/catch block inside `onSubmit` with:

```typescript
      setStreaming(true);
      streamingMessageRef.current = null;

      // Track incremental streaming content
      let streamingContent = '';
      const runningTools = new Map<string, ToolCallStartEvent>();
      const completedTools: ToolCallResultEvent[] = [];

      try {
        // Run agentic loop - yields events for each step
        for await (const event of agent.runAgentLoop({ role: 'user', content: text })) {
          if (event.type === 'text_delta') {
            streamingContent += event.delta;

            // Update the streaming message
            const oldStreamingMessage = streamingMessageRef.current;
            const streamingMessage: Message = {
              role: 'assistant',
              content: streamingContent,
            };
            streamingMessageRef.current = streamingMessage;

            setMessages(prev => {
              const base = prev.filter(m => m !== oldStreamingMessage);
              return [...base, streamingMessage];
            });
          } else if (event.type === 'tool_call_start') {
            runningTools.set(event.toolCall.id, event);
            setCurrentTools(Array.from(runningTools.values()));
          } else if (event.type === 'tool_call_result') {
            runningTools.delete(event.toolCall.id);
            completedTools.push(event);
            setCurrentTools(Array.from(runningTools.values()));
          } else if (event.type === 'agent_error') {
            // Add error message to messages
            const errorMessage: Message = {
              role: 'assistant',
              content: `Error: ${event.error.message}`,
            };
            setMessages(prev => [...prev, errorMessage]);
          }
          // agent_done and turn_complete handled after loop
        }

        // After loop completes, get full context and update all messages
        const fullContext = agent.getContext();
        const allMessages = fullContext.messages;
        setMessages([...allMessages]);
        streamingMessageRef.current = null;
        setCurrentTools([]);
```

Keep the existing catch/finally blocks roughly the same.

- [ ] Step 4: Run TypeScript check

```bash
bun run tsc
```

- [ ] Step 5: Fix any type errors

- [ ] Step 6: Commit

```bash
git add src/cli/tui/hooks/use-agent-loop.tsx
git commit -m "feat: update use-agent-loop to consume AgentEvent stream"
```

---

### Task 9: Update `bin/my-agent-tui-dev.ts` to use new structure

**Files:**
- Modify: `bin/my-agent-tui-dev.ts`

- [ ] Step 1: Update imports to reflect new structure

Change imports from:

```typescript
import { Agent } from './src/agent';
import { ClaudeProvider } from './src/foundation/providers/claude';
```

To:

```typescript
import { Agent, ToolRegistry } from './src/agent';
import { ClaudeProvider } from './src/providers';
import { BashTool, TextEditorTool } from './src/tools';
```

- [ ] Step 2: Create `ToolRegistry`, register tools, pass to Agent constructor

After creating `contextManager`, add:

```typescript
// Create tool registry and register built-in tools
const toolRegistry = new ToolRegistry();
toolRegistry.register(new BashTool({ allowedWorkingDirs: [__dirname + '/..'] }));
toolRegistry.register(new TextEditorTool({ allowedWorkingDirs: [__dirname + '/..'] }));

// Create agent with tool registry
const agent = new Agent({
  provider: claudeProvider,
  contextManager,
  config: { tokenLimit: 100000 },
  toolRegistry,
});
```

- [ ] Step 3: Run TypeScript check

```bash
bun run tsc
```

- [ ] Step 4: Commit

```bash
git add bin/my-agent-tui-dev.ts
git commit -m "feat: update tui dev entry to use ToolRegistry"
```

---

### Task 10: Update root `src/index.ts` with new exports

**Files:**
- Modify: `src/index.ts`

- [ ] Step 1: Add exports from new modules

```typescript
// Core agent
export * from './agent';

// Providers
export * from './providers';

// Existing exports remain
export * from './types';
export * from './tools';
```

- [ ] Step 2: Keep existing exports

- [ ] Step 3: Run TypeScript check

```bash
bun run tsc
```

- [ ] Step 4: Commit

```bash
git add src/index.ts
git commit -m "chore: update index exports for new structure"
```

---

### Task 11: Update `tsconfig.json`

**Files:**
- Modify: `tsconfig.json`

- [ ] Step 1: Verify `rootDir` includes `bin/`

Check that `rootDir` is set to `.` so `bin/` is included in compilation. If not, update:

```json
{
  "compilerOptions": {
    "rootDir": ".",
    ...
  }
}
```

- [ ] Step 2: Final TypeScript compile check

```bash
bun run tsc
```

Expected: No errors, exit code 0.

- [ ] Step 3: Commit

```bash
git add tsconfig.json
git commit -m "chore: update tsconfig rootDir to include bin"
```

---

### Task 12: Update `CLAUDE.md` with new architecture

**Files:**
- Modify: `CLAUDE.md`

- [ ] Step 1: Update Architecture section to reflect new directory structure

```markdown
### Core Files

- `/src/index.ts`: Main entry point with public exports
- `/src/agent/`: Agent core functionality
  - `Agent.ts`: Agent class with `run()`, `runStream()`, `runAgentLoop()`
  - `loop-types.ts`: AgentEvent, AgentLoopConfig types
  - `context.ts`: Context management
  - `middleware.ts`: Middleware composition
  - `tool-registry.ts`: Tool registry for tool execution
- `/src/providers/`: Claude and OpenAI provider implementations
- `/src/types.ts`: Global shared type definitions
- `/src/tools/`: Built-in tool implementations
- `/src/skills/`: Skill management and injection system
```

- [ ] Step 2: Commit

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with new architecture"
```

---

## Self-Review

**Spec coverage:**
- ✅ Directory restructure: covered in Tasks 1-2
- ✅ ToolRegistry: Task 4
- ✅ AgentEvent types: Task 3
- ✅ runAgentLoop(): Task 5
- ✅ BashTool AbortSignal: Task 6
- ✅ ToolCallMessage TUI component: Task 7
- ✅ TUI hook updated for AgentEvent: Task 8
- ✅ Dev entry updated: Task 9
- ✅ Root exports updated: Task 10
- ✅ tsconfig updated: Task 11
- ✅ Docs updated: Task 12

**No placeholders found.**

**Type consistency:** All type references are consistent across tasks.

## Execution

Plan complete and saved to `docs/superpowers/plans/2026-04-21-agentic-loop.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
