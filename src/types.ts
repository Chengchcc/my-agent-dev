import type { ContextManager } from './agent';
import type { ToolContext } from './agent/tool-dispatch/types';

// Structured content block — supports thinking / text / tool_use / tool_result
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

// Core message type - unified format for all providers
export type Message = {
  id?: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Structured content blocks for thinking/text/tool_use — preferred over content string for preservation */
  blocks?: ContentBlock[];
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

// Tool definition for function calling
export type Tool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

// Tool implementation interface
export interface ToolImplementation {
  getDefinition(): Tool;
  /**
   * Unified signature: all tools receive ToolContext as second parameter.
   * Tools that don't need context can simply ignore it.
   */
  execute(params: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
  /** true = pure read, no side effects, can run in parallel with other readonly tools */
  readonly?: boolean;
  /**
   * Conflict key: calls with same key must run sequentially.
   * e.g. edit_file uses `file:${path}`, bash uses `bash:global`.
   * Returns null to allow full parallelism (only makes sense for readonly tools).
   * Default (undefined) = global serialization.
   */
  conflictKey?: (input: unknown) => string | null;
}

// Tool call in response
export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

// LLM completion response
export type LLMResponse = {
  content: string;
  /** Structured blocks including thinking — preferred when provider supports reasoning */
  blocks?: ContentBlock[];
  tool_calls?: ToolCall[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  model: string;
};

// Streaming chunk response
export type LLMResponseChunk = {
  content: string;
  /** Thinking / reasoning delta (split from content for structured preservation) */
  thinking?: string;
  /** Signature for thinking block (Anthropic extended thinking) */
  thinkingSignature?: string;
  /** Opaque redacted thinking data (Anthropic) */
  redactedThinking?: string;
  done: boolean;
  tool_calls?: ToolCall[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

// Compression strategy interface
export interface CompressionStrategy {
  compress(context: AgentContext, tokenLimit: number): Promise<Message[]>;
}

// LLM Configuration
export type LLMConfig = {
  model: string;
  apiKey: string;
  baseURL?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
};

// Agent configuration
export type AgentConfig = {
  tokenLimit: number;
  defaultSystemPrompt?: string;
  /** Override the default model for this invocation (used by memory extraction) */
  model?: string;
};

// Agent context - flows through middleware and agent loop
export type AgentContext = {
  messages: Message[];
  config: AgentConfig;
  metadata: Record<string, unknown>;
  response?: LLMResponse;
  systemPrompt?: string;
};

// Provider interface - all LLM providers must implement this
export interface Provider {
  registerTools(tools: Tool[]): void;
  invoke(context: AgentContext): Promise<LLMResponse>;
  stream(context: AgentContext, options?: { signal?: AbortSignal }): AsyncIterable<LLMResponseChunk>;
  /** Get the name of the model this provider uses */
  getModelName(): string;
}

// Onion-style middleware function
export type Middleware = (
  context: AgentContext,
  next: () => Promise<AgentContext>
) => Promise<AgentContext>;

// Fine-grained hooks for agent execution pipeline
// Each hook uses the existing Middleware type
export interface AgentHooks {
  // Called before any processing of the agent run starts
  beforeAgentRun?: Middleware[];
  // Called before context compression
  beforeCompress?: Middleware[];
  // Called before invoking the LLM model
  beforeModel?: Middleware[];
  // Called after LLM model returns response
  afterModel?: Middleware[];
  // Called before adding the assistant response to context
  beforeAddResponse?: Middleware[];
  // Called after the agent run completes, response added to context
  afterAgentRun?: Middleware[];
}

// AgentMiddleware interface - single middleware per hook slot
// Used for middleware components that return a complete hook object
// matching helixent's architecture pattern
export interface AgentMiddleware {
  beforeAgentRun?: Middleware;
  beforeCompress?: Middleware;
  beforeModel?: Middleware;
  afterModel?: Middleware;
  beforeAddResponse?: Middleware;
  afterAgentRun?: Middleware;
}

// Agent constructor options
export type AgentConstructorOptions = {
  provider: Provider;
  contextManager: ContextManager;
  middleware?: Middleware[];
  hooks?: AgentHooks;
  config: AgentConfig;
};

/** Extract plain text from structured content blocks, ignoring thinking. */
export function flattenBlocks(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text)
    .join('');
}

/** Synthesize ContentBlock[] from a legacy Message that may lack blocks. */
export function synthesizeBlocksFromLegacy(msg: Message): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (msg.content) {
    blocks.push({ type: 'text', text: msg.content });
  }
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      blocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: tc.arguments,
      });
    }
  }
  // Preserve existing blocks if present
  if (msg.blocks) {
    for (const b of msg.blocks) {
      if (b.type !== 'text' && b.type !== 'tool_use') {
        blocks.push(b);
      }
    }
  }
  return blocks;
}
