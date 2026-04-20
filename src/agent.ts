import type { AgentContext, AgentConfig, LLMResponse, LLMResponseChunk, Middleware, Provider, ToolCall, AgentHooks } from './types';
import { ContextManager } from './context';
import { composeMiddlewares } from './middleware';

export class Agent {
  private provider: Provider;
  private contextManager: ContextManager;
  private middleware: Middleware[];
  private hooks: Required<AgentHooks>;
  private config: AgentConfig;

  constructor(options: {
    provider: Provider;
    contextManager: ContextManager;
    middleware?: Middleware[];
    hooks?: AgentHooks;
    config: AgentConfig;
  }) {
    this.provider = options.provider;
    this.contextManager = options.contextManager;
    this.middleware = options.middleware ?? [];
    this.config = options.config;
    // Default all hook arrays to empty
    this.hooks = {
      beforeAgentRun: options.hooks?.beforeAgentRun ?? [],
      beforeCompress: options.hooks?.beforeCompress ?? [],
      beforeModel: options.hooks?.beforeModel ?? [],
      afterModel: options.hooks?.afterModel ?? [],
      beforeAddResponse: options.hooks?.beforeAddResponse ?? [],
      afterAgentRun: options.hooks?.afterAgentRun ?? [],
    };
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
    const composedWithHooks = composeMiddlewares(
      this.hooks.beforeModel,
      async (ctx) => {
        const response = await this.provider.invoke(ctx);
        ctx.response = response;
        return ctx;
      }
    );

    // Run through beforeModel hooks then invoke model
    const afterBeforeModel = await composedWithHooks(afterBeforeCompress);

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
    await composedBeforeAgentRun(initialContext);

    // Add user message to context
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

    for await (const chunk of this.provider.stream(resultContext)) {
      fullContent += chunk.content;
      if (chunk.tool_calls) {
        tool_calls.push(...chunk.tool_calls);
      }
      yield chunk;
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
   * Get context manager.
   */
  getContextManager(): ContextManager {
    return this.contextManager;
  }
}
