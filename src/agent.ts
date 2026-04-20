import type { AgentContext, AgentConfig, LLMResponse, LLMResponseChunk, Middleware, Provider, ToolCall } from './types';
import { ContextManager } from './context';
import { composeMiddlewares } from './middleware';

export class Agent {
  private provider: Provider;
  private contextManager: ContextManager;
  private middleware: Middleware[];
  private config: AgentConfig;

  constructor(options: {
    provider: Provider;
    contextManager: ContextManager;
    middleware?: Middleware[];
    config: AgentConfig;
  }) {
    this.provider = options.provider;
    this.contextManager = options.contextManager;
    this.middleware = options.middleware ?? [];
    this.config = options.config;
  }

  /**
   * Run one full turn of the agent loop (blocking).
   */
  async run(userMessage: { role: 'user'; content: string }): Promise<AgentContext> {
    // Add user message to context
    this.contextManager.addMessage({
      role: 'user',
      content: userMessage.content,
    });

    // Get current context
    const context = this.contextManager.getContext(this.config);

    // Compress if needed
    const compressedMessages = await this.contextManager.compressIfNeeded(context);
    context.messages = compressedMessages;

    // Compose middleware with final handler that calls provider
    const composed = composeMiddlewares(this.middleware, async (ctx) => {
      const response = await this.provider.invoke(ctx);
      ctx.response = response;
      return ctx;
    });

    // Run through pipeline
    const resultContext = await composed(context);

    // Add response to context history
    if (resultContext.response) {
      this.contextManager.addMessage({
        role: 'assistant',
        content: resultContext.response.content,
        tool_calls: resultContext.response.tool_calls,
      });
    }

    return resultContext;
  }

  /**
   * Run one turn with streaming response.
   */
  async *runStream(
    userMessage: { role: 'user'; content: string }
  ): AsyncIterable<LLMResponseChunk> {
    // Add user message to context
    this.contextManager.addMessage({
      role: 'user',
      content: userMessage.content,
    });

    // Get current context
    const context = this.contextManager.getContext(this.config);

    // Compress if needed
    const compressedMessages = await this.contextManager.compressIfNeeded(context);
    context.messages = compressedMessages;

    // Compose middleware with a final handler that will receive the processed context
    let fullContent = '';
    let tool_calls: ToolCall[] = [];
    let resultContext: AgentContext;

    const composed = composeMiddlewares(this.middleware, async (ctx) => {
      // Middleware has processed the context, store it for streaming
      resultContext = ctx;
      return ctx;
    });

    // Run through the middleware pipeline
    resultContext = await composed(context);

    // After middleware completes, stream the chunks from the provider
    for await (const chunk of this.provider.stream(resultContext)) {
      fullContent += chunk.content;
      if (chunk.tool_calls) {
        tool_calls.push(...chunk.tool_calls);
      }
      yield chunk;
    }

    // Set the full response on the context for consistency with run()
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

    // Accumulate full content and tool calls, add to context after streaming completes
    if (resultContext.response) {
      this.contextManager.addMessage({
        role: 'assistant',
        content: resultContext.response.content,
        tool_calls: resultContext.response.tool_calls,
      });
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
   * Get context manager.
   */
  getContextManager(): ContextManager {
    return this.contextManager;
  }
}
