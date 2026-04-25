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
import type { AgentEvent, AgentLoopConfig, ContextCompactedEvent } from './loop-types';
import { ContextManager } from './context';
import { composeMiddlewares } from './middleware';
import { DEFAULT_LOOP_CONFIG } from './loop-types';
import { ToolRegistry } from './tool-registry';
import { ToolDispatcher } from './tool-dispatch/dispatcher';
import { createToolSink } from './tool-dispatch/types';
import type { ToolMiddleware } from './tool-dispatch/middleware';
import { checkBatchBudget, checkToolBudget, type BudgetCheckResult } from './budget-guard';
import { nanoid } from 'nanoid';

export class Agent {
  private provider: Provider;
  private contextManager: ContextManager;
  private hooks: Required<AgentHooks>;
  readonly config: AgentConfig;
  private toolRegistry: ToolRegistry | null;
  private abortController: AbortController | null = null;
  private dispatcher: ToolDispatcher;

  constructor(options: {
    provider: Provider;
    contextManager: ContextManager;
    hooks?: AgentHooks;
    config: AgentConfig;
    toolRegistry?: ToolRegistry;
    /** @deprecated Use hooks.beforeModel instead */
    middleware?: Middleware[];
    toolMiddlewares?: ToolMiddleware[];
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

    // Initialize ToolDispatcher
    this.dispatcher = new ToolDispatcher(
      this.toolRegistry ?? new ToolRegistry(),
      options.toolMiddlewares ?? [],
    );

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
   * Build ToolContext from current agent state
   */
  private buildToolContext(agentCtx: AgentContext, signal: AbortSignal): any {
    return {
      signal,
      agentContext: Object.freeze({ ...agentCtx }),
      budget: {
        remaining: this.contextManager.getRemainingBudget(),
        usageRatio: this.contextManager.getUsageRatio(),
      },
      environment: {
        agentType: 'main' as const,
        cwd: process.cwd(),
      },
      metadata: new Map(),
      sink: createToolSink(),
    };
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

      // Keep looping until we either:
      // 1. Are done (LLLM returned no tool calls)
      // 2. Have reached maxTurns total LLM calls
      // 3. Are aborted
      // Note: If the maxTurns-th LLM call has tool calls, we still need to execute the tools
      // and then do one more LLM call for the summary - so we allow entering the loop for
      // all turn indices from 0 to config.maxTurns inclusive
      while (turnIndex <= config.maxTurns && !done && !signal.aborted) {
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

        const compactionResult = await this.contextManager.compressIfNeeded(
          afterBeforeCompress,
        );
        afterBeforeCompress.messages = compactionResult.messages;
        this.contextManager.setMessages(compactionResult.messages);

        // Emit event if compaction occurred
        if (compactionResult.compacted) {
          yield {
            type: 'context_compacted',
            level: compactionResult.level,
            beforeTokens: compactionResult.tokensBefore,
            afterTokens: compactionResult.tokensAfter,
            turnIndex,
          } satisfies ContextCompactedEvent;
        }

        // b. Run beforeModel middleware
        const composedBeforeModel = composeMiddlewares(
          this.hooks.beforeModel,
          (innerCtx) => Promise.resolve(innerCtx),
        );
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
            // Update token tracking with accurate usage from API
            if (usage && this.contextManager) {
              this.contextManager.updateTokenUsage(usage);
            }
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
            usage,
          } satisfies AgentEvent;
          break;
        }

        // h. We have tool calls - yield turn complete
        yield {
          type: 'turn_complete',
          turnIndex,
          hasToolCalls: true,
          usage,
        } satisfies AgentEvent;

        // ===== Budget Guard: Check if tool calls fit in remaining budget =====
        const remaining = this.contextManager.getRemainingBudget();
        const totalLimit = this.config.tokenLimit;

        // First check the entire batch
        const batchCheck = checkBatchBudget(tool_calls, remaining, totalLimit);

        if (batchCheck.action === 'delegate-to-sub-agent') {
          // Whole batch gets delegated to sub-agent
          yield {
            type: 'budget_delegation',
            reason: batchCheck.reason!,
            originalTools: tool_calls.map(tc => tc.name),
            turnIndex,
          } satisfies import('./loop-types').BudgetDelegationEvent;

          // Replace all original tool calls with a single sub-agent call
          const subId = `budget-sub-${nanoid(6)}`;
          const subAgentCall: ToolCall = {
            id: subId,
            name: 'sub_agent',
            arguments: { task: batchCheck.delegatedTask! },
          };
          tool_calls.length = 0;
          tool_calls.push(subAgentCall);

          // Update the assistant message in context
          this.contextManager.replaceLastAssistantToolCalls(tool_calls);
        } else if (batchCheck.action === 'compact-first') {
          // Compact first, then proceed
          yield {
            type: 'budget_compact',
            reason: batchCheck.reason!,
            turnIndex,
          } satisfies import('./loop-types').BudgetCompactEvent;

          const currentContext = this.contextManager.getContext(this.config);
          const compressed = await this.contextManager.compressIfNeeded(currentContext);
          this.contextManager.setMessages(compressed.messages);
        } else {
          // Batch okay, check individual tools - replace some if needed
          for (let i = 0; i < tool_calls.length; i++) {
            const remainingAfterPrevious = this.contextManager.getRemainingBudget();
            const singleCheck = checkToolBudget(tool_calls[i], remainingAfterPrevious, totalLimit);
            if (singleCheck.action === 'delegate-to-sub-agent') {
              yield {
                type: 'budget_delegation',
                reason: singleCheck.reason!,
                originalTools: [tool_calls[i].name],
                turnIndex,
              } satisfies import('./loop-types').BudgetDelegationEvent;

              const subId = `budget-sub-${nanoid(6)}`;
              tool_calls[i] = {
                id: subId,
                name: 'sub_agent',
                arguments: { task: singleCheck.delegatedTask! },
              };
              // Update after replacement
              this.contextManager.replaceLastAssistantToolCalls(tool_calls);
            } else if (singleCheck.action === 'compact-first') {
              yield {
                type: 'budget_compact',
                reason: singleCheck.reason!,
                turnIndex,
              } satisfies import('./loop-types').BudgetCompactEvent;

              const currentContext = this.contextManager.getContext(this.config);
              const compressed = await this.contextManager.compressIfNeeded(currentContext);
              this.contextManager.setMessages(compressed.messages);
            }
          }
        }
        // ===== Budget Guard done =====

        // i. Execute tool calls via ToolDispatcher
        const toolCtx = this.buildToolContext(resultContext, signal);
        const dispatchOptions = {
          parallel: config.parallelToolExecution,
          yieldAsCompleted: config.yieldEventsAsToolsComplete,
          toolTimeoutMs: config.toolTimeoutMs,
          maxOutputChars: config.maxToolOutputChars,
          errorStrategy: config.toolErrorStrategy,
        };

        for await (const event of this.dispatcher.dispatch(tool_calls, toolCtx, dispatchOptions)) {
          switch (event.type) {
            case 'tool:start':
              yield {
                type: 'tool_call_start',
                toolCall: event.toolCall,
                turnIndex,
              } satisfies AgentEvent;
              break;

            case 'tool:result':
              yield {
                type: 'tool_call_result',
                toolCall: event.toolCall,
                result: event.result.content,
                error: event.result.isError ? new Error(event.result.content) : undefined,
                durationMs: event.result.durationMs,
                isError: event.result.isError,
                turnIndex,
              } satisfies AgentEvent;

              // Add tool result to context
              this.contextManager.addMessage({
                role: 'tool',
                content: event.result.content,
                tool_call_id: event.toolCall.id,
                name: event.toolCall.name,
              });

              // Handle todo updates from sink
              if (event.result.todoUpdates) {
                const currentTodoState = this.contextManager.getTodoState();
                this.contextManager.setTodoState({
                  ...currentTodoState,
                  todos: event.result.todoUpdates,
                });
              }

              // Error strategy: halt on error
              if (event.result.isError && config.toolErrorStrategy === 'halt') {
                throw new Error(event.result.content);
              }
              break;
          }
        }

        // Increment turn index **after** tool execution, before checking loop condition again
        // This ensures that after we've executed tools on this turn, we get another turn for the summary
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
      // When max_turns_reached: we've executed turnIndex + 1 rounds (0..turnIndex inclusive), so total = turnIndex + 1
      // (Loop allows up to config.maxTurns inclusive, so when we exit we've done turnIndex + 1 total turns)
      const totalTurns = done ? turnIndex + 1 : turnIndex;
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

  /**
   * Get the name of the model from the provider.
   */
  getModelName(): string {
    return this.provider.getModelName();
  }
}
