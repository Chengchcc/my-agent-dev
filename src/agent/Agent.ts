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

  /**
   * Run one full turn of the agent loop (blocking).
   */
  async run(userMessage: { role: 'user'; content: string }): Promise<AgentContext> {
    // 1. beforeAgentRun hooks
    const initialContext = this.contextManager.getContext(this.config);
    const composedBeforeAgentRun = composeMiddlewares(
      this.hooks.beforeAgentRun,
      (ctx) => Promise.resolve(ctx)
    );
    const afterBeforeAgentRun = await composedBeforeAgentRun(initialContext);

    // Add user message to context after hooks
    this.contextManager.addMessage({
      role: 'user',
      content: userMessage.content,
    });

    // Get current context after adding user message
    const context = this.contextManager.getContext(this.config);

    // 2. beforeCompress hooks
    const composedBeforeCompress = composeMiddlewares(
      this.hooks.beforeCompress,
      (ctx) => Promise.resolve(ctx)
    );
    const afterBeforeCompress = await composedBeforeCompress(context);

    // Compress if needed
    const compressedMessages = await this.contextManager.compressIfNeeded(afterBeforeCompress);
    afterBeforeCompress.messages = compressedMessages;

    // 3. beforeModel hooks + provider invocation
    const outerComposed = composeMiddlewares(
      this.middleware,
      async (ctx) => {
        const composedBeforeModel = composeMiddlewares(
          this.hooks.beforeModel,
          (innerCtx) => Promise.resolve(innerCtx)
        );
        const afterBeforeModel = await composedBeforeModel(ctx);
        const response = await this.provider.invoke(afterBeforeModel);
        afterBeforeModel.response = response;
        return afterBeforeModel;
      }
    );

    // Run through middleware, beforeModel hooks, then invoke model
    const afterBeforeModel = await outerComposed(afterBeforeCompress);

    // 4. afterModel hooks
    const composedAfterModel = composeMiddlewares(
      this.hooks.afterModel,
      (ctx) => Promise.resolve(ctx)
    );
    const afterAfterModel = await composedAfterModel(afterBeforeModel);

    // 5. beforeAddResponse hooks
    const composedBeforeAddResponse = composeMiddlewares(
      this.hooks.beforeAddResponse,
      (ctx) => Promise.resolve(ctx)
    );
    const afterBeforeAddResponse = await composedBeforeAddResponse(afterAfterModel);

    // Add response to context history after hooks
    if (afterBeforeAddResponse.response) {
      this.contextManager.addMessage({
        role: 'assistant',
        content: afterBeforeAddResponse.response.content,
        tool_calls: afterBeforeAddResponse.response.tool_calls,
      });
    }

    // 6. afterAgentRun hooks
    const finalContext = this.contextManager.getContext(this.config);
    // Merge metadata from previous transformations
    Object.assign(finalContext.metadata, afterBeforeAddResponse.metadata);
    const composedAfterAgentRun = composeMiddlewares(
      this.hooks.afterAgentRun,
      (ctx) => Promise.resolve(ctx)
    );
    const result = await composedAfterAgentRun(finalContext);

    return result;
  }

  /**
   * Run one turn with streaming response.
   */
  async *runStream(
    userMessage: { role: 'user'; content: string }
  ): AsyncIterable<LLMResponseChunk> {
    // beforeAgentRun
    const initialContext = this.contextManager.getContext(this.config);
    const composedBeforeAgentRun = composeMiddlewares(
      this.hooks.beforeAgentRun,
      (ctx) => Promise.resolve(ctx)
    );
    const afterBeforeAgentRun = await composedBeforeAgentRun(initialContext);

    // Add user message to context after hooks
    this.contextManager.addMessage({
      role: 'user',
      content: userMessage.content,
    });

    // Get current context
    const context = this.contextManager.getContext(this.config);

    // beforeCompress
    const composedBeforeCompress = composeMiddlewares(
      this.hooks.beforeCompress,
      (ctx) => Promise.resolve(ctx)
    );
    const afterBeforeCompress = await composedBeforeCompress(context);

    // Compress if needed
    const compressedMessages = await this.contextManager.compressIfNeeded(afterBeforeCompress);
    afterBeforeCompress.messages = compressedMessages;

    // Compose middleware (outer user middleware) + beforeModel hooks
    const outerComposed = composeMiddlewares(
      this.middleware,
      async (ctx) => {
        const composedBeforeModel = composeMiddlewares(
          this.hooks.beforeModel,
          (innerCtx) => Promise.resolve(innerCtx)
        );
        return composedBeforeModel(ctx);
      }
    );

    // Run through pipeline
    let resultContext = await outerComposed(afterBeforeCompress);

    // After middleware and beforeModel hooks, stream from provider
    let fullContent = '';
    let tool_calls: ToolCall[] = [];

    // Create abort controller for this streaming request
    if (this.abortController) {
      // Abort any previous ongoing request
      this.abortController.abort();
    }
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    try {
      for await (const chunk of this.provider.stream(resultContext, { signal })) {
        if (signal.aborted) break;
        fullContent += chunk.content;
        if (chunk.tool_calls) {
          tool_calls.push(...chunk.tool_calls);
        }
        yield chunk;
      }
    } finally {
      this.abortController = null;
    }

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

    // afterModel
    const composedAfterModel = composeMiddlewares(
      this.hooks.afterModel,
      (ctx) => Promise.resolve(ctx)
    );
    resultContext = await composedAfterModel(resultContext);

    // beforeAddResponse
    const composedBeforeAddResponse = composeMiddlewares(
      this.hooks.beforeAddResponse,
      (ctx) => Promise.resolve(ctx)
    );
    resultContext = await composedBeforeAddResponse(resultContext);

    // Add to context
    if (resultContext.response) {
      this.contextManager.addMessage({
        role: 'assistant',
        content: resultContext.response.content,
        tool_calls: resultContext.response.tool_calls,
      });
    }

    // afterAgentRun
    const finalContext = this.contextManager.getContext(this.config);
    // Merge metadata from previous transformations
    Object.assign(finalContext.metadata, resultContext.metadata);
    const composedAfterAgentRun = composeMiddlewares(
      this.hooks.afterAgentRun,
      (ctx) => Promise.resolve(ctx)
    );
    await composedAfterAgentRun(finalContext);
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

    let turnIndex = 0;
    let done = false;
    let errorOccurred = false;

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
          // Execute in parallel and yield as each tool completes
          // First, yield all the start events immediately
          for (const toolCall of tool_calls) {
            yield {
              type: 'tool_call_start',
              toolCall,
              turnIndex,
            } satisfies AgentEvent;
          }

          // Execute all tools in parallel and collect results with promises
          const results = await Promise.allSettled(
            tool_calls.map(async (toolCall) => {
              const result = await this.executeToolCall(
                toolCall,
                config.maxToolOutputChars,
                config.toolTimeoutMs,
                signal,
              );
              return { toolCall, result };
            })
          );

          // Yield results as they completed - actually Promise.allSettled
          // already waits for everything, but we can yield each result now
          // Since everything is already done, this yields immediately
          // after all tools complete, preserving the "start all first" pattern
          for (let i = 0; i < results.length; i++) {
            const item = results[i];
            const toolCall = tool_calls[i];
            if (item.status === 'fulfilled') {
              const { result } = item.value;
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
            } else {
              // Unhandled rejection case
              const error = item.reason instanceof Error
                ? item.reason
                : new Error(String(item.reason));
              yield {
                type: 'tool_call_result',
                toolCall,
                result: `Error: ${error.message}`,
                error,
                turnIndex,
              } satisfies AgentEvent;

              const content = `Error: ${error.message}`;
              this.contextManager.addMessage({
                role: 'tool',
                content,
                tool_call_id: toolCall.id,
                name: toolCall.name,
              });

              if (config.toolErrorStrategy === 'halt') {
                throw error;
              }
            }
          }
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

            let result: { result: unknown; error?: Error };
            const resultItem = results[i];
            if (resultItem.status === 'fulfilled') {
              result = resultItem.value;
            } else {
              // Unhandled rejection case
              const error = resultItem.reason instanceof Error
                ? resultItem.reason
                : new Error(String(resultItem.reason));
              result = {
                result: `Error: ${error.message}`,
                error,
              };
            }

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
      let reason: 'completed' | 'max_turns_reached' | 'error' = 'completed';
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
