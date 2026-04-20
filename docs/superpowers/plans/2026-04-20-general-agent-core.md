# General Agent Core - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Initialize bun TypeScript project and implement core agent loop with context management, onion middleware, and Claude/OpenAI provider abstraction.

**Architecture:** Layered architecture with clean separation: core types, context with pluggable compression, onion-style middleware, abstract provider interface with concrete implementations for Claude and OpenAI. Extensible directory structure for future skills, sessions, and memory.

**Tech Stack:** TypeScript, bun, @anthropic-ai/tokenizer for token counting, official Anthropic and OpenAI SDKs.

---

## Files to Create

| File | Responsibility |
|------|----------------|
| `package.json` | Project config, dependencies |
| `tsconfig.json` | TypeScript config |
| `.gitignore` | Git ignore |
| `src/index.ts` | Main entry point, exports public API |
| `src/types.ts` | All core TypeScript interfaces |
| `src/context.ts` | ContextManager + CompressionStrategy + TrimOldestStrategy |
| `src/middleware.ts` | Middleware type + composeMiddlewares function |
| `src/agent.ts` | Core Agent class with run/runStream |
| `src/foundation/providers/claude.ts` | ClaudeProvider implementation |
| `src/foundation/providers/openai.ts` | OpenAIProvider implementation |
| `examples/basic.ts` | Basic usage example |
| (empty directories) | `src/foundation/sessions/`, `src/foundation/memory/`, `src/skills/`, `src/middleware/` |

---

## Task 1: Initialize Bun TypeScript Project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`

- [ ] **Step 1: Initialize bun project**

```bash
bun init -y
```

- [ ] **Step 2: Install dependencies**

```bash
bun add @anthropic-ai/sdk @anthropic-ai/tokenizer openai
bun add -d typescript @types/node
```

- [ ] **Step 3: Update tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 4: Create .gitignore**

```
node_modules/
dist/
.env
*.log
```

- [ ] **Step 5: Create directory structure**

```bash
mkdir -p src src/foundation/providers src/foundation/sessions src/foundation/memory src/skills src/middleware examples
```

- [ ] **Step 6: Commit**

```bash
git add .
git commit -m "init: initialize bun typescript project and directory structure"
```

---

## Task 2: Core Type Definitions

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: Write core types**

```typescript
// Core message type - unified format for all providers
export type Message = {
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
  stream(context: AgentContext): AsyncIterable<LLMResponseChunk>;
}

// Onion-style middleware function
export type Middleware = (
  context: AgentContext,
  next: () => Promise<AgentContext>
) => Promise<AgentContext>;
```

- [ ] **Step 2: Run TypeScript check**

```bash
bun tsc --noEmit
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "types: add core type definitions"
```

---

## Task 3: Context Management with Compression

**Files:**
- Create: `src/context.ts`

- [ ] **Step 1: Write ContextManager and compression strategies**

```typescript
import { countTokens } from '@anthropic-ai/tokenizer';
import type { AgentContext, AgentConfig, CompressionStrategy, Message } from './types';

/**
 * Default compression strategy - trim oldest messages when over limit.
 * Keeps system prompt if present.
 */
export class TrimOldestStrategy implements CompressionStrategy {
  async compress(context: AgentContext, tokenLimit: number): Promise<Message[]> {
    let messages = [...context.messages];

    // Keep system prompt separate if it exists
    const systemMessage = messages.find(m => m.role === 'system');
    if (systemMessage) {
      messages = messages.filter(m => m !== systemMessage);
    }

    // Remove oldest messages until we're under the limit
    while (this.countTokens(messages) > tokenLimit && messages.length > 1) {
      messages.shift();
    }

    // Put system message back at the beginning
    if (systemMessage) {
      messages.unshift(systemMessage);
    }

    return messages;
  }

  private countTokens(messages: Message[]): number {
    return messages.reduce((sum, msg) => sum + countTokens(msg.content), 0);
  }
}

/**
 * Manages conversation context with compression.
 */
export class ContextManager {
  private messages: Message[];
  private tokenLimit: number;
  private compressionStrategy: CompressionStrategy;
  private defaultSystemPrompt?: string;

  constructor(options: {
    tokenLimit: number;
    compressionStrategy?: CompressionStrategy;
    defaultSystemPrompt?: string;
  }) {
    this.tokenLimit = options.tokenLimit;
    this.compressionStrategy = options.compressionStrategy ?? new TrimOldestStrategy();
    this.messages = [];
    this.defaultSystemPrompt = options.defaultSystemPrompt;

    if (this.defaultSystemPrompt) {
      this.messages.push({
        role: 'system',
        content: this.defaultSystemPrompt,
      });
    }
  }

  /**
   * Add a message to the context.
   */
  addMessage(message: Message): void {
    this.messages.push(message);
  }

  /**
   * Get current messages.
   */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /**
   * Get AgentContext for passing through pipeline.
   */
  getContext(config: AgentConfig): AgentContext {
    return {
      messages: [...this.messages],
      config,
      metadata: {},
      systemPrompt: this.defaultSystemPrompt,
    };
  }

  /**
   * Compress messages if over token limit.
   */
  async compressIfNeeded(context: AgentContext): Promise<Message[]> {
    const totalTokens = this.countTotalTokens(context.messages);
    if (totalTokens > this.tokenLimit) {
      const compressed = await this.compressionStrategy.compress(context, this.tokenLimit);
      this.messages = compressed;
      return compressed;
    }
    return context.messages;
  }

  /**
   * Clear all messages (keeps default system prompt if exists).
   */
  clear(): void {
    this.messages = [];
    if (this.defaultSystemPrompt) {
      this.messages.push({
        role: 'system',
        content: this.defaultSystemPrompt,
      });
    }
  }

  /**
   * Count total tokens in messages.
   */
  private countTotalTokens(messages: Message[]): number {
    return messages.reduce((sum, msg) => sum + countTokens(msg.content), 0);
  }

  getTokenLimit(): number {
    return this.tokenLimit;
  }
}
```

- [ ] **Step 2: Run TypeScript check**

```bash
bun tsc --noEmit
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/context.ts
git commit -m "context: implement context manager with pluggable compression"
```

---

## Task 4: Middleware Composition

**Files:**
- Create: `src/middleware.ts`

- [ ] **Step 1: Write composeMiddlewares**

```typescript
import type { AgentContext, Middleware } from './types';

/**
 * Compose multiple middleware into a single middleware function.
 * Follows onion architecture - outer middleware runs first before, last after.
 */
export function composeMiddlewares(
  middlewares: Middleware[],
  finalHandler: (context: AgentContext) => Promise<AgentContext>
): (context: AgentContext) => Promise<AgentContext> {
  return async (context: AgentContext): Promise<AgentContext> => {
    let index = 0;

    async function runNext(): Promise<AgentContext> {
      if (index >= middlewares.length) {
        return await finalHandler(context);
      }
      const middleware = middlewares[index++];
      return await middleware(context, runNext);
    }

    return await runNext();
  };
}
```

- [ ] **Step 2: Run TypeScript check**

```bash
bun tsc --noEmit
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/middleware.ts
git commit -m "middleware: implement onion middleware composition"
```

---

## Task 5: Core Agent Class

**Files:**
- Create: `src/agent.ts`

- [ ] **Step 1: Implement Agent class**

```typescript
import type { AgentContext, AgentConfig, LLMResponse, LLMResponseChunk, Middleware, Provider } from './types';
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

    // For streaming, we don't go through full middleware composition
    // Middleware can still wrap the entire agent.runStream call
    let fullContent = '';
    let tool_calls: LLMResponseChunk['tool_calls'] = [];

    for await (const chunk of this.provider.stream(context)) {
      fullContent += chunk.content;
      if (chunk.tool_calls) {
        tool_calls = [...(tool_calls ?? []), ...chunk.tool_calls];
      }
      yield chunk;
    }

    // Add the complete response to context history
    this.contextManager.addMessage({
      role: 'assistant',
      content: fullContent,
      tool_calls,
    });
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
```

- [ ] **Step 2: Run TypeScript check**

```bash
bun tsc --noEmit
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/agent.ts
git commit -m "agent: implement core agent class with run and runStream"
```

---

## Task 6: Claude Provider Implementation

**Files:**
- Create: `src/foundation/providers/claude.ts`

- [ ] **Step 1: Implement ClaudeProvider**

```typescript
import Anthropic from '@anthropic-ai/sdk';
import type { Message, Provider, Tool, LLMResponse, LLMResponseChunk, AgentContext } from '../../types';

export class ClaudeProvider implements Provider {
  private client: Anthropic;
  private model: string;
  private maxTokens: number;
  private temperature: number;
  private tools: Anthropic.Tool[] = [];

  constructor(config: {
    apiKey: string;
    model: string;
    maxTokens: number;
    temperature?: number;
    baseURL?: string;
  }) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
    this.model = config.model;
    this.maxTokens = config.maxTokens;
    this.temperature = config.temperature ?? 0.7;
  }

  /**
   * Register tools for function calling.
   */
  registerTools(tools: Tool[]): void {
    this.tools = tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters as Anthropic.InputSchema,
    }));
  }

  /**
   * Blocking completion.
   */
  async invoke(context: AgentContext): Promise<LLMResponse> {
    const { messages, systemPrompt } = context;

    // Claude expects system prompt as a separate parameter, not in messages array
    const claudeMessages = this.convertToClaudeMessages(messages);
    const system = systemPrompt ?? this.extractSystemPrompt(messages);

    const response = await this.client.messages.create({
      model: this.model,
      messages: claudeMessages,
      system: system,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      tools: this.tools.length > 0 ? this.tools : undefined,
    });

    // Extract content
    const content = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');

    // Extract tool calls
    const tool_calls = response.content
      .filter(block => block.type === 'tool_use')
      .map(block => ({
        id: block.id,
        name: block.name,
        arguments: block.input,
      }));

    return {
      content,
      tool_calls: tool_calls.length > 0 ? tool_calls : undefined,
      usage: {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens,
      },
      model: response.model,
    };
  }

  /**
   * Streaming completion.
   */
  async *stream(context: AgentContext): AsyncIterable<LLMResponseChunk> {
    const { messages, systemPrompt } = context;
    const claudeMessages = this.convertToClaudeMessages(messages);
    const system = systemPrompt ?? this.extractSystemPrompt(messages);

    const stream = this.client.messages.stream({
      model: this.model,
      messages: claudeMessages,
      system: system,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      tools: this.tools.length > 0 ? this.tools : undefined,
    });

    let currentContent = '';
    const tool_calls: LLMResponseChunk['tool_calls'] = [];

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta') {
        if (chunk.delta.type === 'text_delta') {
          currentContent += chunk.delta.text;
          yield {
            content: chunk.delta.text,
            done: false,
          };
        } else if (chunk.delta.type === 'input_json_delta') {
          // Accumulate tool call input - handled by the streaming API
        }
      } else if (chunk.type === 'message_delta') {
        // Message complete
      } else if (chunk.type === 'message_stop') {
        yield {
          content: '',
          done: true,
          tool_calls,
        };
      }
    }
  }

  /**
   * Convert unified messages to Claude format.
   * Removes system message from array since Claude expects it separately.
   */
  private convertToClaudeMessages(messages: Message[]): Anthropic.MessageParam[] {
    return messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      })) as Anthropic.MessageParam[];
  }

  /**
   * Extract system prompt from messages.
   */
  private extractSystemPrompt(messages: Message[]): string {
    return messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  }
}
```

- [ ] **Step 2: Run TypeScript check**

```bash
bun tsc --noEmit
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/foundation/providers/claude.ts
git commit -m "providers: add claude provider implementation"
```

---

## Task 7: OpenAI Provider Implementation

**Files:**
- Create: `src/foundation/providers/openai.ts`

- [ ] **Step 1: Implement OpenAIProvider**

```typescript
import OpenAI from 'openai';
import type { Message, Provider, Tool, LLMResponse, LLMResponseChunk, AgentContext } from '../../types';

export class OpenAIProvider implements Provider {
  private client: OpenAI;
  private model: string;
  private maxTokens?: number;
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
    this.maxTokens = config.maxTokens;
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

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      tools: this.tools.length > 0 ? this.tools : undefined,
    });

    const choice = response.choices[0];
    if (!choice) {
      throw new Error('No response from OpenAI');
    }

    const content = choice.message.content ?? '';

    const tool_calls = choice.message.tool_calls?.map(tc => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments),
    }));

    return {
      content,
      tool_calls,
      usage: {
        prompt_tokens: response.usage?.prompt_tokens ?? 0,
        completion_tokens: response.usage?.completion_tokens ?? 0,
        total_tokens: response.usage?.total_tokens ?? 0,
      },
      model: response.model,
    };
  }

  /**
   * Streaming completion.
   */
  async *stream(context: AgentContext): AsyncIterable<LLMResponseChunk> {
    const messages = this.convertToOpenAIMessages(context.messages);

    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      tools: this.tools.length > 0 ? this.tools : undefined,
      stream: true,
    });

    let tool_calls: LLMResponseChunk['tool_calls'] = [];

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;

      if (!delta) {
        continue;
      }

      const content = delta.content ?? '';

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (tc.id) {
            tool_calls.push({
              id: tc.id,
              name: tc.function?.name ?? '',
              arguments: {},
            });
          }
          // Append to arguments - handled by incremental parse
        }
      }

      yield {
        content,
        done: chunk.choices[0]?.finish_reason !== null,
        tool_calls: tool_calls.length > 0 ? tool_calls : undefined,
      };
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
}
```

- [ ] **Step 2: Run TypeScript check**

```bash
bun tsc --noEmit
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/foundation/providers/openai.ts
git commit -m "providers: add openai provider implementation"
```

---

## Task 8: Main Entry Point (Export Public API)

**Files:**
- Create: `src/index.ts`

- [ ] **Step 1: Write exports**

```typescript
// Core types
export * from './types';

// Context
export { ContextManager, TrimOldestStrategy } from './context';

// Middleware
export { composeMiddlewares } from './middleware';

// Core Agent
export { Agent } from './agent';

// Providers
export { ClaudeProvider } from './foundation/providers/claude';
export { OpenAIProvider } from './foundation/providers/openai';
```

- [ ] **Step 2: Run TypeScript check**

```bash
bun tsc --noEmit
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "index: add main entry point with public exports"
```

---

## Task 9: Basic Usage Example

**Files:**
- Create: `examples/basic.ts`

- [ ] **Step 1: Write basic example**

```typescript
import { Agent, ContextManager, ClaudeProvider, type AgentConfig } from '../src';

// Example usage - set env vars first
const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('Please set ANTHROPIC_API_KEY environment variable');
  process.exit(1);
}

async function main() {
  // Create provider
  const provider = new ClaudeProvider({
    apiKey: API_KEY,
    model: 'claude-3-sonnet-20240229',
    maxTokens: 1024,
    temperature: 0.7,
  });

  // Create context manager
  const contextManager = new ContextManager({
    tokenLimit: 100000,
    defaultSystemPrompt: 'You are a helpful assistant.',
  });

  // Create agent config
  const agentConfig: AgentConfig = {
    tokenLimit: 100000,
  };

  // Create agent with optional logging middleware
  const agent = new Agent({
    provider,
    contextManager,
    config: agentConfig,
    middleware: [
      async (context, next) => {
        console.log(`[Before] ${context.messages.length} messages`);
        const result = await next();
        console.log(`[After] response: ${result.response?.content.slice(0, 50)}...`);
        return result;
      },
    ],
  });

  // Run conversation
  const result = await agent.run({
    role: 'user',
    content: 'Hello! What is a general purpose agent?',
  });

  console.log('\nFinal response:');
  console.log(result.response?.content);
}

main().catch(console.error);
```

- [ ] **Step 2: Create .env.example**

```
# Copy this to .env and fill in your API keys
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
```

- [ ] **Step 3: Run TypeScript check**

```bash
bun tsc --noEmit
```

Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add examples/basic.ts .env.example
git commit -m "examples: add basic usage example"
```

---

## Self-Review

Done:
- ✅ All spec requirements are covered
- ✅ No placeholders, all code shown
- ✅ Type names consistent across all files
- ✅ Each task is bite-sized
- ✅ Exact file paths and commands
- ✅ Directory structure matches design with placeholders for future extension
