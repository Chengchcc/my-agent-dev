import type {
  AgentContext,
  AgentConfig,
  Provider,
  ToolCall,
  AgentHooks,
  ContentBlock,
} from '../types';
import type { AgentEvent, AgentLoopConfig, ContextCompactedEvent } from './loop-types';
import type { ToolContext } from './tool-dispatch/types';
import type { ContextManager } from './context';
import { composeMiddlewares } from './middleware';
import { DEFAULT_LOOP_CONFIG } from './loop-types';
import type { ToolDispatcher } from './tool-dispatch/dispatcher';
import { createToolSink } from './tool-dispatch/types';
import { checkBatchBudget, checkToolBudget } from './budget-guard';
import { debugLog } from '../utils/debug';
import { nanoid } from 'nanoid';

export class AgentLoop {
  private controller: AbortController | null = null;

  constructor(
    private provider: Provider,
    private contextManager: ContextManager,
    private hooks: Required<AgentHooks>,
    private config: AgentConfig,
    private dispatcher: ToolDispatcher,
  ) {}

  /** Abort the active run. Safe to call from any thread. */
  abort(): void {
    if (this.controller) {
      this.controller.abort();
    }
  }

  /**
   * Run the full autonomous agentic loop:
   * LLM → execute tool_calls → repeat until no more tool calls.
   * Yields events for each step for observable execution.
   */
  async *run(
    userMessage: { role: 'user'; content: string },
    loopConfig?: Partial<AgentLoopConfig>,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<AgentEvent> {
    const config: AgentLoopConfig = { ...DEFAULT_LOOP_CONFIG, ...loopConfig };
    const controller = new AbortController();
    this.controller = controller;
    const signal = controller.signal;

    // Chain from external signal if provided - propagate abort
    if (options?.signal) {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

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
      await this.runSetup(userMessage);

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
          debugLog(`[agent] main-loop calling runTools: ${turnResult.toolCalls.length} tools t=${performance.now().toFixed(0)}`);
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
      this.controller = null;
    }
  }

  // ===== Phase 1: Setup =====

  private async runSetup(
    userMessage: { role: 'user'; content: string },
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

  // ===== Phase 2: Single LLM turn =====

   
  // eslint-disable-next-line complexity, max-lines-per-function
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
    let thinkingBuffer = '';
    let thinkingSignature: string | undefined;
    const toolCalls: ToolCall[] = [];
    let usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    } | undefined;

    for await (const chunk of this.provider.stream(resultContext, { signal })) {
      if (signal.aborted) break;
      if (chunk.thinking) {
        thinkingBuffer += chunk.thinking;
        yield {
          type: 'thinking_delta',
          delta: chunk.thinking,
          turnIndex,
        } satisfies AgentEvent;
      }
      if (chunk.thinkingSignature) {
        thinkingSignature = chunk.thinkingSignature;
        yield {
          type: 'thinking_done',
          signature: chunk.thinkingSignature,
          turnIndex,
        } satisfies AgentEvent;
      }
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
      model: this.provider.getModelName(),
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
      const blocks: ContentBlock[] = [];
      if (thinkingBuffer) {
        blocks.push({
          type: 'thinking',
          thinking: thinkingBuffer,
          ...(thinkingSignature ? { signature: thinkingSignature } : {}),
        });
      }
      if (fullContent) {
        blocks.push({ type: 'text', text: fullContent });
      }
      for (const tc of toolCalls) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.arguments,
        });
      }

      if (blocks.length > 0) resultContext.response.blocks = blocks;

      const msg: { role: 'assistant'; content: string; blocks?: typeof blocks; tool_calls?: ToolCall[] } = {
        role: 'assistant',
        content: resultContext.response.content,
        ...(blocks.length > 0 ? { blocks } : {}),
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
    debugLog(`[agent] runSingleTurn yielding turn_complete: t=${performance.now().toFixed(0)}`);
    yield turnCompleteEvent as AgentEvent;
    debugLog(`[agent] runSingleTurn resumed after turn_complete yield: t=${performance.now().toFixed(0)}`);

    return { toolCalls, resultContext, done };
  }

  // ===== Phase 3: Tool execution =====

  private async *runTools(
    toolCalls: ToolCall[],
    resultContext: AgentContext,
    config: AgentLoopConfig,
    signal: AbortSignal,
    turnIndex: number,
  ): AsyncGenerator<AgentEvent> {
    debugLog(`[agent] runTools ENTRY: ${toolCalls.length} tools, turn=${turnIndex} t=${performance.now().toFixed(0)}`);
    const remaining = this.contextManager.getRemainingBudget();
    const totalLimit = this.config.tokenLimit;

    debugLog(`[agent] runTools budget-check START: t=${performance.now().toFixed(0)}`);
    const batchCheck = checkBatchBudget(toolCalls, remaining, totalLimit);
    debugLog(`[agent] runTools batch-check DONE: action=${batchCheck.action} t=${performance.now().toFixed(0)}`);
    if (batchCheck.action === 'delegate-to-sub-agent') {
      yield {
        type: 'budget_delegation',
        reason: batchCheck.reason!,
        originalTools: toolCalls.map(tc => tc.name),
        turnIndex,
      } satisfies import('./loop-types').BudgetDelegationEvent // eslint-disable-line @typescript-eslint/consistent-type-imports

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
      } satisfies import('./loop-types').BudgetCompactEvent // eslint-disable-line @typescript-eslint/consistent-type-imports

      const currentContext = this.contextManager.getContext(this.config);
      const compressed = await this.contextManager.compressIfNeeded(currentContext);
      this.contextManager.setMessages(compressed.messages);
    } else {
      for (const [index, toolCall] of toolCalls.entries()) {
        debugLog(`[agent] runTools single-check START: ${toolCall.name} t=${performance.now().toFixed(0)}`);
        const remainingAfterPrevious = this.contextManager.getRemainingBudget();
        const singleCheck = checkToolBudget(toolCall, remainingAfterPrevious, totalLimit);
        debugLog(`[agent] runTools single-check DONE: ${toolCall.name} action=${singleCheck.action} t=${performance.now().toFixed(0)}`);
        if (singleCheck.action === 'delegate-to-sub-agent') {
          yield {
            type: 'budget_delegation',
            reason: singleCheck.reason!,
            originalTools: [toolCall.name],
            turnIndex,
          } satisfies import('./loop-types').BudgetDelegationEvent // eslint-disable-line @typescript-eslint/consistent-type-imports

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
          } satisfies import('./loop-types').BudgetCompactEvent // eslint-disable-line @typescript-eslint/consistent-type-imports

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

    debugLog(`[agent] runTools: dispatching ${toolCalls.length} tools, parallel=${dispatchOptions.parallel}, yieldAsCompleted=${dispatchOptions.yieldAsCompleted}, turn=${turnIndex}`);
    let eventCount = 0;
    for await (const event of this.dispatcher.dispatch(toolCalls, toolCtx, dispatchOptions)) {
      eventCount++;
      debugLog(`[agent] runTools RECEIVED event #${eventCount}: ${event.type} ${event.toolCall.name}#${event.toolCall.id} t=${performance.now().toFixed(0)}`);
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

          if (event.result.isError && config.toolErrorStrategy === 'halt') {
            throw new Error(content);
          }

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

          yield {
            type: 'tool_call_result',
            toolCall: event.toolCall,
            result: content,
            durationMs: event.result.durationMs,
            isError: event.result.isError,
            ...(event.result.isError ? { error: new Error(content) } : {}),
            turnIndex,
          } satisfies AgentEvent;
      }
    }
    debugLog(`[agent] runTools dispatch loop done: ${eventCount} events received`);
  }

  // ===== Phase 4: Teardown =====

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

  // ===== Helpers =====

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
}
