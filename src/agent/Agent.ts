import type {
  AgentContext,
  AgentConfig,
  Middleware,
  Provider,
  ToolCall,
  AgentHooks,
} from '../types';
import type { AgentEvent, AgentLoopConfig, ContextCompactedEvent } from './loop-types';
import type { ToolContext } from './tool-dispatch/types';
import { ContextManager } from './context';
import { composeMiddlewares } from './middleware';
import { DEFAULT_LOOP_CONFIG } from './loop-types';
import { ToolRegistry } from './tool-registry';
import { ToolDispatcher } from './tool-dispatch/dispatcher';
import { createToolSink } from './tool-dispatch/types';
import type { ToolMiddleware } from './tool-dispatch/middleware';
import { checkBatchBudget, checkToolBudget } from './budget-guard';
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
  private buildToolContext(agentCtx: AgentContext, signal: AbortSignal): ToolContext {
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

  // ===== Internal loop helpers: 4-phase architecture =====

  /**
   * Phase 1: Setup - initialize state, add user message, run beforeAgentRun hooks
   */
  private async runSetup(
    userMessage: { role: 'user'; content: string },
    _config: AgentLoopConfig,
  ): Promise<void> {
    this.contextManager.addMessage({
      role: 'user',
      content: userMessage.content,
    });

    const initialContext = this.contextManager.getContext(this.config);
    const composedBeforeAgentRun = composeMiddlewares(
      this.hooks.beforeAgentRun,
      (ctx) => Promise.resolve(ctx),
    );
    const afterBeforeAgentRun = await composedBeforeAgentRun(initialContext);

    if (afterBeforeAgentRun.systemPrompt) {
      this.contextManager.setSystemPrompt(afterBeforeAgentRun.systemPrompt);
    }
    this.contextManager.syncTodoFromContext(afterBeforeAgentRun);
  }

  /**
   * Phase 2: Single turn execution - compaction → beforeModel → LLM stream → afterModel → beforeAddResponse
   */
  private async *runSingleTurn(
    turnIndex: number,
    _config: AgentLoopConfig,
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent, {
    toolCalls: ToolCall[];
    resultContext: AgentContext;
    done: boolean;
  }> {
    const currentContext = this.contextManager.getContext(this.config);
    const composedBeforeCompress = composeMiddlewares(
      this.hooks.beforeCompress,
      (ctx) => Promise.resolve(ctx),
    );

    let afterBeforeCompress: AgentContext;
    try {
      afterBeforeCompress = await composedBeforeCompress(currentContext);
    } catch (hookError) {
      console.warn('[agent] beforeCompress hook failed:', hookError);
      afterBeforeCompress = currentContext;
    }
    this.contextManager.syncTodoFromContext(afterBeforeCompress);

    const compactionResult = await this.contextManager.compressIfNeeded(afterBeforeCompress);
    afterBeforeCompress.messages = compactionResult.messages;
    this.contextManager.setMessages(compactionResult.messages);

    if (compactionResult.compacted) {
      yield {
        type: 'context_compacted',
        level: compactionResult.level,
        beforeTokens: compactionResult.tokensBefore,
        afterTokens: compactionResult.tokensAfter,
        turnIndex,
      } satisfies ContextCompactedEvent;
    }

    const composedBeforeModel = composeMiddlewares(
      this.hooks.beforeModel,
      (innerCtx) => Promise.resolve(innerCtx),
    );
    let resultContext: AgentContext;
    try {
      resultContext = await composedBeforeModel(afterBeforeCompress);
    } catch (hookError) {
      console.warn('[agent] beforeModel hook failed:', hookError);
      resultContext = afterBeforeCompress;
    }
    this.contextManager.syncTodoFromContext(resultContext);

    // Stream from LLM
    let fullContent = '';
    const toolCalls: ToolCall[] = [];
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
        for (const tc of chunk.tool_calls) {
          if (!toolCalls.some(existing => existing.id === tc.id)) {
            toolCalls.push(tc);
          }
        }
      }
      if (chunk.usage) {
        usage = chunk.usage;
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
      return { toolCalls: [], resultContext, done: true };
    }

    const composedAfterModel = composeMiddlewares(
      this.hooks.afterModel,
      (ctx) => Promise.resolve(ctx),
    );
    try {
      resultContext = await composedAfterModel(resultContext);
    } catch (hookError) {
      console.warn('[agent] afterModel hook failed:', hookError);
    }
    this.contextManager.syncTodoFromContext(resultContext);

    resultContext.response = {
      content: fullContent,
      usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      model: this.provider.constructor.name,
    };
    if (toolCalls.length > 0) {
      resultContext.response.tool_calls = toolCalls;
    }

    const composedBeforeAddResponse = composeMiddlewares(
      this.hooks.beforeAddResponse,
      (ctx) => Promise.resolve(ctx),
    );
    resultContext = await composedBeforeAddResponse(resultContext);
    this.contextManager.syncTodoFromContext(resultContext);

    if (resultContext.response) {
      const msg: { role: 'assistant'; content: string; tool_calls?: ToolCall[] } = {
        role: 'assistant',
        content: resultContext.response.content,
      };
      if (resultContext.response.tool_calls && resultContext.response.tool_calls.length > 0) {
        msg.tool_calls = resultContext.response.tool_calls;
      }
      this.contextManager.addMessage(msg);
    }

    const done = !toolCalls || toolCalls.length === 0;
    const turnCompleteEvent: { type: 'turn_complete'; turnIndex: number; hasToolCalls: boolean; usage?: typeof usage } = {
      type: 'turn_complete',
      turnIndex,
      hasToolCalls: !done,
    };
    if (usage) {
      turnCompleteEvent.usage = usage;
    }
    yield turnCompleteEvent as AgentEvent;

    return { toolCalls, resultContext, done };
  }

  /**
   * Phase 3: Tool execution - with budget guard
   */
  private async *runTools(
    toolCalls: ToolCall[],
    resultContext: AgentContext,
    config: AgentLoopConfig,
    signal: AbortSignal,
    turnIndex: number,
  ): AsyncGenerator<AgentEvent> {
    const remaining = this.contextManager.getRemainingBudget();
    const totalLimit = this.config.tokenLimit;

    const batchCheck = checkBatchBudget(toolCalls, remaining, totalLimit);
    if (batchCheck.action === 'delegate-to-sub-agent') {
      yield {
        type: 'budget_delegation',
        reason: batchCheck.reason!,
        originalTools: toolCalls.map(tc => tc.name),
        turnIndex,
      } satisfies import('./loop-types').BudgetDelegationEvent;

      const subId = `budget-sub-${nanoid(6)}`;
      const subAgentCall: ToolCall = {
        id: subId,
        name: 'sub_agent',
        arguments: { task: batchCheck.delegatedTask! },
      };
      toolCalls.length = 0;
      toolCalls.push(subAgentCall);
      this.contextManager.replaceLastAssistantToolCalls(toolCalls);
    } else if (batchCheck.action === 'compact-first') {
      yield {
        type: 'budget_compact',
        reason: batchCheck.reason!,
        turnIndex,
      } satisfies import('./loop-types').BudgetCompactEvent;

      const currentContext = this.contextManager.getContext(this.config);
      const compressed = await this.contextManager.compressIfNeeded(currentContext);
      this.contextManager.setMessages(compressed.messages);
    } else {
      for (const [index, toolCall] of toolCalls.entries()) {
        const remainingAfterPrevious = this.contextManager.getRemainingBudget();
        const singleCheck = checkToolBudget(toolCall, remainingAfterPrevious, totalLimit);
        if (singleCheck.action === 'delegate-to-sub-agent') {
          yield {
            type: 'budget_delegation',
            reason: singleCheck.reason!,
            originalTools: [toolCall.name],
            turnIndex,
          } satisfies import('./loop-types').BudgetDelegationEvent;

          const subId = `budget-sub-${nanoid(6)}`;
          toolCalls[index] = {
            id: subId,
            name: 'sub_agent',
            arguments: { task: singleCheck.delegatedTask! },
          };
          this.contextManager.replaceLastAssistantToolCalls(toolCalls);
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

    const toolCtx = this.buildToolContext(resultContext, signal);
    const dispatchOptions = {
      parallel: config.parallelToolExecution,
      yieldAsCompleted: config.yieldEventsAsToolsComplete,
      toolTimeoutMs: config.toolTimeoutMs,
      maxOutputChars: config.maxToolOutputChars,
    };

    for await (const event of this.dispatcher.dispatch(toolCalls, toolCtx, dispatchOptions)) {
      switch (event.type) {
        case 'tool:start':
          yield {
            type: 'tool_call_start',
            toolCall: event.toolCall,
            turnIndex,
          } satisfies AgentEvent;
          break;

        case 'tool:result':
          const rawContent = event.result.content;
          const content = typeof rawContent === 'string'
            ? rawContent
            : JSON.stringify(rawContent);

          // CHECK FIRST: throw halt error before side effects (yield + addMessage)
          // This prevents state inconsistency where context has the error message
          // but the agent crashed without the TUI being able to handle it cleanly
          if (event.result.isError && config.toolErrorStrategy === 'halt') {
            throw new Error(content);
          }

          const toolResultEvent: any = {
            type: 'tool_call_result',
            toolCall: event.toolCall,
            result: content,
            durationMs: event.result.durationMs,
            isError: event.result.isError,
            turnIndex,
          };
          if (event.result.isError) {
            toolResultEvent.error = new Error(content);
          }
          yield toolResultEvent as AgentEvent;

          this.contextManager.addMessage({
            role: 'tool',
            content,
            tool_call_id: event.toolCall.id,
            name: event.toolCall.name,
          });

          if (event.result.todoUpdates) {
            const currentTodoState = this.contextManager.getTodoState();
            this.contextManager.setTodoState({
              ...currentTodoState,
              todos: event.result.todoUpdates,
            });
          }
          break;
      }
    }
  }

  /**
   * Phase 4: Teardown - run afterAgentRun hooks and completion logic
   */
  private async *runTeardown(
    lastResultContext: AgentContext | undefined,
    config: AgentLoopConfig,
    turnIndex: number,
    done: boolean,
    errorOccurred: boolean,
  ): AsyncGenerator<AgentEvent> {
    if (lastResultContext) {
      const todoState = this.contextManager.getTodoState();
      const finalContext = {
        ...lastResultContext,
        ...this.contextManager.getContext(this.config),
        metadata: {
          ...lastResultContext.metadata,
          todo: {
            ...(lastResultContext.metadata.todo || {}),
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
        console.warn('[agent] afterAgentRun hook failed:', hookError);
      }
    }

    let reason: 'completed' | 'max_turns_reached' | 'error' = 'completed';
    if (errorOccurred) {
      reason = 'error';
    } else if (turnIndex >= config.maxTurns && !done) {
      reason = 'max_turns_reached';
    }

    const totalTurns = done ? turnIndex + 1 : turnIndex;
    yield {
      type: 'agent_done',
      totalTurns,
      reason,
      turnIndex,
    } satisfies AgentEvent;
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
    let lastResultContext: AgentContext | undefined;

    try {
      // Phase 1: Setup
      await this.runSetup(userMessage, config);

      // Main loop: Phase 2 (LLM turn) -> Phase 3 (Tools)
      while (turnIndex <= config.maxTurns && !done && !signal.aborted) {
        // Phase 2: Single LLM turn
        const turnResult = yield* this.runSingleTurn(turnIndex, config, signal);
        done = turnResult.done;
        lastResultContext = turnResult.resultContext;

        if (signal.aborted) {
          errorOccurred = true;
          break;
        }

        if (!done && turnResult.toolCalls.length > 0) {
          // Phase 3: Execute tools
          yield* this.runTools(
            turnResult.toolCalls,
            turnResult.resultContext,
            config,
            signal,
            turnIndex,
          );
          turnIndex++;
        }
      }

      // Phase 4: Teardown
      yield* this.runTeardown(lastResultContext, config, turnIndex, done, errorOccurred);
    } catch (error) {
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
