import type { ContextManager } from './agent';
import type { ToolContext } from './agent/tool-dispatch/types';

// Core message type - unified format for all providers
export type Message = {
  id?: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
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
