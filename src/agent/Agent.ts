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
} from '../types';
import type { AgentEvent, AgentLoopConfig } from './loop-types';
import { ContextManager } from './context';
import { composeMiddlewares } from './middleware';
import { DEFAULT_LOOP_CONFIG } from './loop-types';
import { ToolRegistry } from './tool-registry';

export class Agent {
  private provider: Provider;
  private contextManager: ContextManager;
  private hooks: Required<AgentHooks>;
  private config: AgentConfig;
  private toolRegistry: ToolRegistry | null;
  private abortController: AbortController | null = null;

  constructor(options: {
    provider: Provider;
    contextManager: ContextManager;
    hooks?: AgentHooks;
    config: AgentConfig;
    toolRegistry?: ToolRegistry;
    /** @deprecated Use hooks.beforeModel instead */
    middleware?: Middleware[];
  }) {
    this.provider = options.provider;
    this.contextManager = options.contextManager;
    this.config = options.config;
    this.toolRegistry = options.toolRegistry ?? null;
    // Default all hook arrays to empty
    this.hooks = {
      beforeAgentRun: options.hooks?.beforeAgentRun ?? [],
      beforeCompress: options.hooks?.beforeCompress ?? [],
      // For backward compatibility: add deprecated middleware to beforeModel
      beforeModel: [
        ...(options.middleware ?? []),
        ...(options.hooks?.beforeModel ?? []),
      ],
      afterModel: options.hooks?.afterModel ?? [],
      beforeAddResponse: options.hooks?.beforeAddResponse ?? [],
      afterAgentRun: options.hooks?.afterAgentRun ?? [],
    };

    // Auto-register tools with provider if registry exists
    if (this.toolRegistry) {
      this.provider.registerTools(this.toolRegistry.getAllDefinitions());
    }
  }



  /**
   * Get current context.
   */
  getContext(): AgentContext {
    return this.contextManager.getContext(this.config);
  }

  /**
   * Clear conversation context.
   */
  clear(): void {
    this.contextManager.clear();
  }

  /**
   * Abort the currently running streaming request.
   * Cleans up the abort controller after aborting the request.
   */
  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

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

  /**
   * Execute a single tool call with timeout.
   */
  private async executeToolCall(
    toolCall: ToolCall,
    maxOutputChars: number,
    toolTimeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ result: unknown; error?: Error; durationMs: number }> {
    const startTime = Date.now();
    const tool = this.toolRegistry?.get(toolCall.name);

    if (!tool) {
      const durationMs = Date.now() - startTime;
      return {
        result: `Error: Tool '${toolCall.name}' not found in registry.`,
        durationMs,
      };
    }

    try {
      // Create timeout promise
      let timeoutId: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<{ result: unknown; error?: Error; durationMs: number }>(
        (resolve) => {
          timeoutId = setTimeout(() => {
            const durationMs = Date.now() - startTime;
            resolve({
              result: `Error: Tool execution timed out after ${toolTimeoutMs}ms.`,
              error: new Error(`Tool timeout after ${toolTimeoutMs}ms`),
              durationMs,
            });
          }, toolTimeoutMs);
        }
      );

      // Execute tool with potential signal
      const executePromise = (async () => {
        // If ToolImplementation.execute doesn't accept signal, we just run it
        // For tools that do accept signal, pass it through
        // Tools that need access to context can also receive it as an option
        // Check explicitly via the requiresContext flag first (more reliable than function.length)
        try {
          const needsContext = tool.requiresContext ?? (tool.execute.length > 1);
          if (needsContext) {
            const currentContext = this.contextManager.getContext(this.config);
            const toolFn = tool.execute as (
              params: Record<string, unknown>,
              opts?: { signal?: AbortSignal; context: AgentContext },
            ) => Promise<unknown>;
            const result = await toolFn.call(tool, toolCall.arguments, { signal, context: currentContext });
            // Sync any changes to todo state back to contextManager
            this.contextManager.syncTodoFromContext(currentContext);
            return { result, durationMs: Date.now() - startTime };
          }
          const result = await tool.execute(toolCall.arguments);
          return { result, durationMs: Date.now() - startTime };
        } catch (error) {
          throw error;
        }
      })();

      // Race between timeout and execution
      let result: { result: unknown; error?: Error; durationMs: number };
      try {
        result = await Promise.race([executePromise, timeoutPromise]);
      } finally {
        // Clear the timeout if we got a result before it fired
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
      }

      // Truncate if output is a string
      if (typeof result.result === 'string') {
        return {
          ...result,
          result: this.truncateOutput(result.result, maxOutputChars)
        };
      }
      if (
        result.result &&
        typeof (result.result as { output?: string }).output === 'string'
      ) {
        (result.result as { output: string }).output = this.truncateOutput(
          (result.result as { output: string }).output,
          maxOutputChars,
        );
      }

      return result;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      return {
        result: `Error executing tool '${toolCall.name}': ${
          error instanceof Error ? error.message : String(error)
        }`,
        error: error instanceof Error ? error : new Error(String(error)),
        durationMs,
      };
    }
  }

  /**
   * Run the full autonomous agentic loop:
   * LLM → execute tool_calls → repeat until no more tool calls.
   * Yields events for each step for observable execution.
   */
  async *runAgentLoop(
    userMessage: { role: 'user'; content: string },
    loopConfig?: Partial<AgentLoopConfig>,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<AgentEvent> {
    const config: AgentLoopConfig = { ...DEFAULT_LOOP_CONFIG, ...loopConfig };
    const controller = new AbortController();
    const signal = controller.signal;

    // Chain from external signal if provided - propagate abort
    if (options?.signal) {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    this.abortController = controller;

    // Create timeout timer
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, config.timeoutMs);

    let turnIndex = 0;
    let done = false;
    let errorOccurred = false;
    let resultContext: AgentContext;

    try {
      // Add user message to context before running hooks
      // This allows SkillMiddleware to check for skill mentions in the user message
      this.contextManager.addMessage({
        role: 'user',
        content: userMessage.content,
      });
      resultContext = this.contextManager.getContext(this.config);

      // 1. beforeAgentRun hooks
      const initialContext = this.contextManager.getContext(this.config);
      const composedBeforeAgentRun = composeMiddlewares(
        this.hooks.beforeAgentRun,
        (ctx) => Promise.resolve(ctx),
      );
      const afterBeforeAgentRun = await composedBeforeAgentRun(initialContext);

      // Save the modified systemPrompt from beforeAgentRun (contains dynamic skill injection)
      this.contextManager.setSystemPrompt(afterBeforeAgentRun.systemPrompt);
      // Sync todo state back to contextManager after middleware
      this.contextManager.syncTodoFromContext(afterBeforeAgentRun);

      while (turnIndex < config.maxTurns && !done && !signal.aborted) {
        // a. Compress context if needed (every turn)
        const currentContext = this.contextManager.getContext(this.config);
        const composedBeforeCompress = composeMiddlewares(
          this.hooks.beforeCompress,
          (ctx) => Promise.resolve(ctx),
        );
        let afterBeforeCompress: AgentContext;
        try {
          afterBeforeCompress = await composedBeforeCompress(currentContext);
        } catch (hookError) {
          // Hook failure shouldn't abort the entire agent loop - log and continue with original context
          console.warn('[agent] beforeCompress hook failed:', hookError);
          afterBeforeCompress = currentContext;
        }

        // Sync todo state back to contextManager after middleware
        this.contextManager.syncTodoFromContext(afterBeforeCompress);

        const compressedMessages = await this.contextManager.compressIfNeeded(
          afterBeforeCompress,
        );
        afterBeforeCompress.messages = compressedMessages;
        this.contextManager.setMessages(compressedMessages);

        // b. Run beforeModel middleware
        const composedBeforeModel = composeMiddlewares(
          this.hooks.beforeModel,
          (innerCtx) => Promise.resolve(innerCtx),
        );
        let resultContext: AgentContext;
        try {
          resultContext = await composedBeforeModel(afterBeforeCompress);
        } catch (hookError) {
          // Hook failure shouldn't abort the entire agent loop - log and continue with original context
          console.warn('[agent] beforeModel hook failed:', hookError);
          resultContext = afterBeforeCompress;
        }

        // Sync todo state back to contextManager after middleware
        this.contextManager.syncTodoFromContext(resultContext);

        // c. Stream from LLM
        let fullContent = '';
        const tool_calls: ToolCall[] = [];
        let usage: {
          prompt_tokens: number;
          completion_tokens: number;
          total_tokens: number;
        } | undefined;

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
            // Deduplicate by id - providers may send the same tool call multiple times
            for (const tc of chunk.tool_calls) {
              if (!tool_calls.some(existing => existing.id === tc.id)) {
                tool_calls.push(tc);
              }
            }
          }
          if (chunk.usage) {
            usage = chunk.usage;
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
        try {
          resultContext = await composedAfterModel(resultContext);
        } catch (hookError) {
          // Hook failure shouldn't abort the entire agent loop - log and continue with original context
          console.warn('[agent] afterModel hook failed:', hookError);
        }

        // Sync todo state back to contextManager after middleware
        this.contextManager.syncTodoFromContext(resultContext);

        // Set full response on context
        resultContext.response = {
          content: fullContent,
          tool_calls: tool_calls.length > 0 ? tool_calls : undefined,
          usage: usage ?? {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
          },
          model: this.provider.constructor.name,
        };

        // e. beforeAddResponse hooks
        const composedBeforeAddResponse = composeMiddlewares(
          this.hooks.beforeAddResponse,
          (ctx) => Promise.resolve(ctx),
        );
        resultContext = await composedBeforeAddResponse(resultContext);

        // Sync todo state back to contextManager after middleware
        this.contextManager.syncTodoFromContext(resultContext);

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
          // Execute in parallel and yield as each tool completes
          // First, yield all the start events immediately
          for (const toolCall of tool_calls) {
            yield {
              type: 'tool_call_start',
              toolCall,
              turnIndex,
            } satisfies AgentEvent;
          }

          // Use a result queue to yield results as soon as they complete
          const pending = new Set(tool_calls.map(tc => tc.id));
          const resultQueue: AgentEvent[] = [];
          let resolveNext: (() => void) | null = null;

          const promises = tool_calls.map(async (toolCall) => {
            const result = await this.executeToolCall(
              toolCall,
              config.maxToolOutputChars,
              config.toolTimeoutMs,
              signal,
            );

            // Add the result to the queue and wake up the yield loop
            resultQueue.push({
              type: 'tool_call_result',
              toolCall,
              result: result.result,
              error: result.error,
              durationMs: result.durationMs,
              isError: !!result.error,
              turnIndex,
            } satisfies AgentEvent);
            pending.delete(toolCall.id);
            resolveNext?.();
          });

          // Yield as results arrive - true incremental streaming
          while (pending.size > 0 || resultQueue.length > 0) {
            if (signal.aborted) {
              break;
            }
            if (resultQueue.length > 0) {
              const event = resultQueue.shift()!;
              yield event;

              // Add to context after yielding
              const toolCall = (event as any).toolCall as ToolCall;
              const result = (event as any).result as unknown;
              const error = (event as any).error as Error | undefined;

              const content =
                result && typeof result === 'string'
                  ? result
                  : JSON.stringify(result, null, 2);

              this.contextManager.addMessage({
                role: 'tool',
                content,
                tool_call_id: toolCall.id,
                name: toolCall.name,
              });

              if (error && config.toolErrorStrategy === 'halt') {
                throw error;
              }
            } else {
              // Wait for the next result to complete
              await new Promise<void>((resolve) => {
                resolveNext = resolve;
                // If we're aborted already, resolve immediately
                if (signal.aborted) {
                  resolve();
                  return;
                }
                // Resolve on abort - prevents deadlock if all pending tools are hanging
                const onAbort = () => resolve();
                signal.addEventListener('abort', onAbort, { once: true });
                // Cleanup listener after resolve
                const originalResolve = resolve;
                resolve = () => {
                  signal.removeEventListener('abort', onAbort);
                  originalResolve();
                };
              });
            }
          }

          // Wait for all promises to settle (cleanup any remaining)
          await Promise.allSettled(promises);
        } else if (config.parallelToolExecution) {
          const startTime = Date.now();
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

            let result: { result: unknown; error?: Error; durationMs: number };
            const resultItem = results[i];
            if (resultItem.status === 'fulfilled') {
              result = resultItem.value;
            } else {
              // Unhandled rejection case
              const error = resultItem.reason instanceof Error
                ? resultItem.reason
                : new Error(String(resultItem.reason));
              const durationMs = Date.now() - startTime;
              result = {
                result: `Error: ${error.message}`,
                error,
                durationMs,
              };
            }

            yield {
              type: 'tool_call_result',
              toolCall,
              result: result.result,
              error: result.error,
              durationMs: result.durationMs,
              isError: !!result.error,
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
              durationMs: result.durationMs,
              isError: !!result.error,
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
      // Start with the last result context that has all metadata modifications from this turn,
      // then refresh the todo metadata from context manager to keep it in sync
      const todoState = this.contextManager.getTodoState();
      const finalContext = {
        ...resultContext,
        ...this.contextManager.getContext(this.config),
        // Keep existing metadata, just refresh the todo section from context manager
        metadata: {
          ...resultContext.metadata,
          todo: {
            ...(resultContext.metadata.todo || {}),
            todoStore: todoState.todos,
            stepsSinceLastWrite: todoState.stepsSinceLastWrite,
            stepsSinceLastReminder: todoState.stepsSinceLastReminder,
          },
        },
      };
      const composedAfterAgentRun = composeMiddlewares(
        this.hooks.afterAgentRun,
        (ctx) => Promise.resolve(ctx),
      );
      try {
        await composedAfterAgentRun(finalContext);
      } catch (hookError) {
        // Hook failure shouldn't abort the entire agent run - log and continue to completion
        console.warn('[agent] afterAgentRun hook failed:', hookError);
      }

      // Determine completion reason
      let reason: 'completed' | 'max_turns_reached' | 'error' = 'completed';
      if (errorOccurred) {
        reason = 'error';
      } else if (turnIndex >= config.maxTurns && !done) {
        reason = 'max_turns_reached';
      }

      // 7. yield agent_done
      // When done: current turn (turnIndex) completed, total = turnIndex + 1 (0-indexed)
      // When max_turns_reached: turnIndex === config.maxTurns because loop condition turnIndex < maxTurns,
      // we already executed all maxTurns rounds (0..maxTurns-1 → executed maxTurns times), so total = turnIndex
      const totalTurns = reason === 'max_turns_reached' ? turnIndex : turnIndex + 1;
      yield {
        type: 'agent_done',
        totalTurns,
        reason,
        turnIndex,
      } satisfies AgentEvent;
    } catch (error) {
      // Handle unexpected errors
      yield {
        type: 'agent_error',
        error: error instanceof Error ? error : new Error(String(error)),
        turnIndex: turnIndex,
      } satisfies AgentEvent;
      yield {
        type: 'agent_done',
        totalTurns: turnIndex + 1,
        reason: 'error',
        error: error instanceof Error ? error : new Error(String(error)),
        turnIndex: turnIndex,
      } satisfies AgentEvent;
    } finally {
      clearTimeout(timeoutId);
      if (this.abortController === controller) {
        this.abortController = null;
      }
    }
  }

  /**
   * Get context manager.
   */
  getContextManager(): ContextManager {
    return this.contextManager;
  }
}
