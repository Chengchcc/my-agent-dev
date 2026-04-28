import OpenAI from 'openai';
import type { Message, Provider, Tool, LLMResponse, LLMResponseChunk, AgentContext } from '../types';

export class OpenAIProvider implements Provider {
  private client: OpenAI;
  private model: string;
  private maxTokens: number;
  private temperature: number;
  private tools: OpenAI.ChatCompletionTool[] = [];

  constructor(config: {
    apiKey: string;
    model: string;
    maxTokens?: number;
    temperature?: number;
    baseURL?: string;
  }) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
    this.model = config.model;
    this.maxTokens = config.maxTokens ?? 4096;
    this.temperature = config.temperature ?? 0.7;
  }

  /**
   * Register tools for function calling.
   */
  registerTools(tools: Tool[]): void {
    this.tools = tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as OpenAI.FunctionParameters,
      },
    }));
  }

  /**
   * Blocking completion.
   */
  async invoke(context: AgentContext): Promise<LLMResponse> {
    const messages = this.convertToOpenAIMessages(context.messages);
    if (context.systemPrompt) {
      messages.unshift({ role: 'system', content: context.systemPrompt });
    }
    const model = context.config?.model ?? this.model;

    const requestOptions: Record<string, unknown> = {
      model,
      messages,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
    };
    if (this.tools.length > 0) requestOptions.tools = this.tools;
    const response = await this.client.chat.completions.create(
      requestOptions as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
    );

    const choice = response.choices[0];
    if (!choice) {
      throw new Error('No response from OpenAI');
    }

    const content = choice.message.content ?? '';

    const tool_calls = choice.message.tool_calls
      ?.filter(tc => tc.type === 'function')
      .map(tc => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments),
      }));

    const result: LLMResponse = {
      content,
      usage: {
        prompt_tokens: response.usage?.prompt_tokens ?? 0,
        completion_tokens: response.usage?.completion_tokens ?? 0,
        total_tokens: response.usage?.total_tokens ?? 0,
      },
      model: response.model,
    };
    if (tool_calls?.length) result.tool_calls = tool_calls;
    return result;
  }

  /**
   * Streaming completion.
   */
   
  // eslint-disable-next-line complexity
  async *stream(context: AgentContext, options?: { signal?: AbortSignal }): AsyncIterable<LLMResponseChunk> {
    const messages = this.convertToOpenAIMessages(context.messages);
    if (context.systemPrompt) {
      messages.unshift({ role: 'system', content: context.systemPrompt });
    }
    const model = context.config?.model ?? this.model;

    const streamOptions: Record<string, unknown> = {
      model,
      messages,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      stream: true,
    };
    if (this.tools.length > 0) streamOptions.tools = this.tools;
    const stream = await this.client.chat.completions.create(
      streamOptions as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
      {
        signal: options?.signal,
      },
    );

    // Track tool calls with accumulated arguments JSON
    let tool_calls: LLMResponseChunk['tool_calls'] = [];
    let accumulated_args: (string | undefined)[] = [];
    let usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    } | undefined;

    for await (const chunk of stream) {
      // OpenAI sends usage in the final chunk
      if (chunk.usage) {
        usage = {
          prompt_tokens: chunk.usage.prompt_tokens,
          completion_tokens: chunk.usage.completion_tokens,
          total_tokens: chunk.usage.total_tokens,
        };
      }

      const delta = chunk.choices[0]?.delta;

      if (!delta) {
        continue;
      }

      const content = delta.content ?? '';

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const index = tc.index ?? 0;
          if (tc.id) {
            tool_calls[index] = {
              id: tc.id,
              name: tc.function?.name ?? '',
              arguments: {},
            };
          }
          // Append incremental arguments - initialize if needed
          if (tc.function?.arguments) {
            if (!tool_calls[index]) {
              tool_calls[index] = {
                id: '',
                name: tc.function?.name ?? '',
                arguments: {},
              };
            }
            if (accumulated_args[index] === undefined) {
              accumulated_args[index] = '';
            }
            accumulated_args[index] += tc.function.arguments;
            // Try to parse incrementally
            try {
              const parsed = JSON.parse(accumulated_args[index]);
              tool_calls[index]!.arguments = parsed;
            } catch {
              // Incomplete JSON, keep parsing - will be parsed again at end
            }
          }
        }
      }

      const finishReason = chunk.choices[0]?.finish_reason;
      const chunkResult: LLMResponseChunk = {
        content,
        done: finishReason != null,
      };
      if (finishReason != null && tool_calls.length > 0) chunkResult.tool_calls = tool_calls;
      if (usage) chunkResult.usage = usage;
      yield chunkResult;
    }

    // Final parse of all accumulated arguments after stream is complete
    for (let i = 0; i < tool_calls.length; i++) {
      const args = accumulated_args[i];
      if (tool_calls[i] && args && args.length > 0) {
        try {
          tool_calls[i]!.arguments = JSON.parse(args);
        } catch (_e) {
          // If parsing fails at the end, leave whatever we have
        }
      }
    }

    // Yield one final time with the completely parsed tool_calls
    // This ensures the consumer gets the fully parsed arguments after completion
    if (tool_calls.length > 0) {
      const finalChunk: LLMResponseChunk = { content: '', done: true, tool_calls };
      if (usage) finalChunk.usage = usage;
      yield finalChunk;
    }
  }

  /**
   * Convert unified messages to OpenAI format.
   */
  private convertToOpenAIMessages(messages: Message[]): OpenAI.ChatCompletionMessageParam[] {
    return messages.map(m => {
      const base = {
        role: m.role as OpenAI.ChatCompletionRole,
        content: m.content,
      };

      if (m.tool_calls && m.role === 'assistant') {
        return {
          ...base,
          tool_calls: m.tool_calls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          })),
        } as OpenAI.ChatCompletionMessageParam;
      }

      if (m.tool_call_id && m.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: m.tool_call_id,
          content: m.content,
        } as OpenAI.ChatCompletionMessageParam;
      }

      return base as OpenAI.ChatCompletionMessageParam;
    });
  }

  getModelName(): string {
    return this.model;
  }
}
