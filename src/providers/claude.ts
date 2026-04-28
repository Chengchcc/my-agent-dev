import Anthropic from '@anthropic-ai/sdk';
import { convertToClaudeMessages, extractSystemPrompt } from './claude-utils';
import type { Provider, Tool, LLMResponse, LLMResponseChunk, AgentContext, ContentBlock } from '../types';
import type { ThinkingDecoder } from './thinking/types';

export class ClaudeProvider implements Provider {
  private client: Anthropic;
  private model: string;
  private maxTokens: number;
  private temperature: number;
  private tools: Anthropic.Tool[] = [];
  private thinkingDecoder: ThinkingDecoder | null;
  private thinkingBudgetTokens: number;

  constructor(config: {
    apiKey: string;
    model: string;
    maxTokens: number;
    temperature?: number;
    baseURL?: string;
    thinkingDecoder?: ThinkingDecoder;
    thinkingBudgetTokens?: number;
  }) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
    this.model = config.model;
    this.maxTokens = config.maxTokens;
    this.temperature = config.temperature ?? 0.7;
    this.thinkingDecoder = config.thinkingDecoder ?? null;
    this.thinkingBudgetTokens = config.thinkingBudgetTokens ?? 8000;
  }

  /**
   * Register tools for function calling.
   */
  registerTools(tools: Tool[]): void {
    this.tools = tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters as Anthropic.Tool.InputSchema,
    }));
  }

  /**
   * Blocking completion.
   */
  async invoke(context: AgentContext): Promise<LLMResponse> {
    const { messages, systemPrompt } = context;

    // Claude expects system prompt as a separate parameter, not in messages array
    const claudeMessages = convertToClaudeMessages(messages);
    const system = systemPrompt ?? extractSystemPrompt(messages);
    const model = context.config?.model ?? this.model;

    const requestOptions: Record<string, unknown> = {
      model,
      messages: claudeMessages,
      system: system,
      max_tokens: this.maxTokens,
      temperature: this.thinkingDecoder ? 1 : this.temperature,
    };
    if (this.thinkingDecoder) {
      requestOptions.thinking = {
        type: 'enabled',
        budget_tokens: this.thinkingBudgetTokens,
      };
    }
    if (this.tools.length > 0) requestOptions.tools = this.tools;
    const response = await this.client.messages.create(
      requestOptions as unknown as Anthropic.MessageCreateParams,
    ) as unknown as Anthropic.Message;

    // Extract text content
    const responseContent = response.content as Anthropic.ContentBlock[];
    const content = responseContent
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map(block => block.text)
      .join('');

    // Extract thinking blocks via decoder
    const blocks: ContentBlock[] = [];
    if (this.thinkingDecoder) {
      for (const block of responseContent) {
        const cb = this.thinkingDecoder.decodeResponseBlock(block);
        if (cb) blocks.push(cb);
      }
    }

    // Extract tool calls
    const tool_calls = responseContent
      .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
      .map(block => ({
        id: block.id,
        name: block.name,
        arguments: block.input as Record<string, unknown>,
      }));

    // Build text blocks from content
    if (content) {
      blocks.unshift({ type: 'text', text: content });
    }

    const result: LLMResponse = {
      content,
      ...(blocks.length > 0 ? { blocks } : {}),
      usage: {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens,
      },
      model: response.model,
    };
    if (tool_calls.length > 0) result.tool_calls = tool_calls;
    return result;
  }

  /**
   * Streaming completion.
   */
   
  // eslint-disable-next-line complexity
  async *stream(context: AgentContext, options?: { signal?: AbortSignal }): AsyncIterable<LLMResponseChunk> {
    const { messages, systemPrompt } = context;
    const claudeMessages = convertToClaudeMessages(messages);
    const system = systemPrompt ?? extractSystemPrompt(messages);
    const model = context.config?.model ?? this.model;

    const streamOptions: Record<string, unknown> = {
      model,
      messages: claudeMessages,
      system: system,
      max_tokens: this.maxTokens,
      temperature: this.thinkingDecoder ? 1 : this.temperature,
    };
    if (this.thinkingDecoder) {
      streamOptions.thinking = {
        type: 'enabled',
        budget_tokens: this.thinkingBudgetTokens,
      };
    }
    if (this.tools.length > 0) streamOptions.tools = this.tools;
    const stream = this.client.messages.stream(
      streamOptions as unknown as Anthropic.MessageCreateParams,
      { signal: options?.signal },
    );

    let _currentContent = '';
    const tool_calls: LLMResponseChunk['tool_calls'] = [];
    let currentToolCall: {
      id: string;
      name: string;
      input: string;
    } | null = null;
    let thinkingState: 'idle' | 'thinking' | 'redacted' = 'idle';
    let usage: {
      input_tokens: number;
      output_tokens: number;
    } | null = null;

    for await (const chunk of stream) {
      if (chunk.type === 'message_start') {
        // Capture real input_tokens from the API
        if (chunk.message?.usage?.input_tokens !== undefined) {
          usage = {
            input_tokens: chunk.message.usage.input_tokens,
            output_tokens: 0,
          };
        }
      } else if (chunk.type === 'content_block_start') {
        const contentBlock = chunk.content_block;
        if (contentBlock?.type === 'thinking') {
          thinkingState = 'thinking';
        } else if (contentBlock?.type === 'redacted_thinking') {
          thinkingState = 'redacted';
        } else if (contentBlock?.type === 'tool_use') {
          // Start of a new tool call
          currentToolCall = {
            id: contentBlock.id,
            name: contentBlock.name,
            input: '',
          };
        }
      } else if (chunk.type === 'content_block_delta') {
        if (thinkingState === 'thinking' && chunk.delta.type === 'thinking_delta') {
          yield {
            content: '',
            thinking: chunk.delta.thinking,
            done: false,
          };
        } else if (thinkingState === 'thinking' && chunk.delta.type === 'signature_delta') {
          yield {
            content: '',
            thinkingSignature: chunk.delta.signature,
            done: false,
          };
        } else if (chunk.delta.type === 'text_delta') {
          _currentContent += chunk.delta.text;
          yield {
            content: chunk.delta.text,
            done: false,
          };
        } else if (chunk.delta.type === 'input_json_delta') {
          // Accumulate partial JSON input for tool call
          if (currentToolCall && chunk.delta.partial_json) {
            currentToolCall.input += chunk.delta.partial_json;
          }
        }
      } else if (chunk.type === 'content_block_stop') {
        // End of a thinking block
        if (thinkingState !== 'idle') {
          thinkingState = 'idle';
        }
        // End of current content block - if it's a tool call, parse and add it
        if (currentToolCall) {
          let fullToolCall: {
            id: string;
            name: string;
            arguments: Record<string, unknown>;
          };
          try {
            const parsedInput = JSON.parse(currentToolCall.input) as Record<string, unknown>;
            fullToolCall = {
              id: currentToolCall.id,
              name: currentToolCall.name,
              arguments: parsedInput,
            };
            tool_calls.push(fullToolCall);
          } catch (_e) {
            // Parse error - add it anyway
            fullToolCall = {
              id: currentToolCall.id,
              name: currentToolCall.name,
              arguments: {},
            };
            tool_calls.push(fullToolCall);
          }
          currentToolCall = null;

          // Yield the completed tool call
          yield {
            content: '',
            done: false,
            tool_calls: [fullToolCall],
          };
        }
      } else if (chunk.type === 'message_delta') {
        // Message delta contains stop_reason and usage
        if (chunk.usage?.output_tokens !== undefined) {
          const prevInput: number = usage?.input_tokens ?? 0;
          usage = {
            input_tokens: prevInput,
            output_tokens: chunk.usage.output_tokens,
          };
        }
      } else if (chunk.type === 'message_stop') {
        // Tool calls have already been yielded incrementally
        // Add usage if we have it
        // Prefer real input_tokens from message_start; fall back to estimation
        const promptTokens = usage?.input_tokens ?? countPromptTokens(claudeMessages);
        const outputTokens = usage?.output_tokens ?? 0;
        yield {
          content: '',
          done: true,
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: outputTokens,
            total_tokens: promptTokens + outputTokens,
          },
        };
      }
    }
  }

  getModelName(): string {
    return this.model;
  }
}

/**
 * Rough estimate of prompt tokens. Used as fallback when the API doesn't provide
 * input_tokens via message_start events (e.g., older API versions).
 *
 * Uses 1 token ~= 3.5 chars for text and 1 ~= 2.5 for JSON (tool input/output)
 * to reduce underestimation bias on structured content.
 */
function countPromptTokens(messages: Anthropic.MessageParam[]): number {
  let estimate = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      estimate += msg.content.length / 3.5;
    } else {
      for (const block of msg.content) {
        if (block.type === 'text') {
          estimate += block.text.length / 3.5;
        } else if (block.type === 'tool_use') {
          const json = JSON.stringify(block.input);
          estimate += (block.name.length + json.length) / 2.5 + 6;
        } else if (block.type === 'tool_result') {
          const content = typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content);
          estimate += content.length / 2.5 + 4;
        } else if (block.type === 'image') {
          estimate += 80; // ~1 token per 4-5 chars of base64 with overhead
        } else {
          // thinking, redacted_thinking, or unknown block types
          estimate += JSON.stringify(block).length / 3;
        }
      }
    }
  }
  return Math.ceil(estimate);
}

