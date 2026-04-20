# General Purpose Agent - Design Spec

**Date:** 2026-04-20
**Goal:** Build a general agent with core agent loop, context management, support for Claude/OpenAI models, and extensible middleware.

## Project Structure

```
my-agent/
├── src/
│   ├── index.ts             # Main entry point (exports public API)
│   ├── types.ts              # Core TypeScript interfaces
│   ├── context.ts           # Context management with compression
│   ├── agent.ts             # Core agent loop
│   ├── middleware.ts        # Middleware types and composition
│   ├── foundation/          # Foundational extensible components
│   │   ├── providers/       # LLM providers
│   │   │   ├── claude.ts    # Claude provider
│   │   │   └── openai.ts    # OpenAI provider
│   │   ├── sessions/        # Session persistence
│   │   │   └── jsonl.ts     # JSONL session storage (v1 structure)
│   │   └── memory/          # Memory implementations (future)
│   ├── skills/              # Skill system (future expansion)
│   └── middleware/          # Custom middleware extensions (user/community)
├── examples/
│   └── basic.ts             # Basic usage example
├── package.json
├── tsconfig.json
└── bun.lockb
```

## Core Design

### 1. Type System (`src/types.ts`)

Core interfaces:
- `Message` - Unified message format works with roles (system, user, assistant, tool)
- `Tool` - Tool definition for function calling
- `LLMResponse` - Unified LLM completion response
- `LLMResponseChunk` - Streaming chunk
- `AgentContext` - Runtime context that flows through middleware and agent
- `AgentConfig` - Top-level agent configuration
- `Provider` - Provider interface (see below)
- `Middleware` - Middleware function type (onion-style)
- `CompressionStrategy` - Interface for context compression strategies
- `ContextManager` - Maintains message history with compression

### 2. Context Management (`src/context.ts`)

The context stores all conversation state and metadata. It supports:

**Pluggable Compression Strategies:**
```typescript
interface CompressionStrategy {
  compress(context: AgentContext, tokenLimit: number): Promise<Message[]>;
}
```

Built-in strategies in v1:
- `TrimOldestStrategy` - (default) removes oldest messages when token limit is reached

Ready for future strategies:
- `SummarizeStrategy` - Use LLM to summarize old messages
- `OffloadStrategy` - Offload large content to external storage

**ContextManager API:**
- `constructor({ compressionStrategy, tokenLimit)
- `addMessage(message)` - add message to history
- `getMessages()` - get current messages
- `compressIfNeeded()` - run compression if over token limit
- `clear()` - clear all messages

### 3. Middleware Design (`src/middleware.ts`)

**Onion-style middleware:**
```typescript
type Middleware = (
  context: AgentContext,
  next: () => Promise<AgentContext>
) => Promise<AgentContext>;
```

- Outer middleware runs first on the way in, last on the way out
- Allows modifying context before LLM call and after LLM response
- Supports logging, debugging, context enrichment, filtering, etc.

**`composeMiddlewares()`** - composes multiple middleware into one function that executes the onion pipeline.

### 4. Provider Abstraction (`src/foundation/providers/`)

Abstract provider interface:
```typescript
interface Provider {
  // Register tools for function calling
  registerTools(tools: Tool[]): void;

  // Blocking completion
  invoke(context: AgentContext): Promise<LLMResponse>;

  // Streaming completion
  stream(context: AgentContext): AsyncIterable<LLMResponseChunk>;
}
```

**Responsibilities:**
- Convert unified `Message` format to provider-specific format
- Handle system prompt placement (differs between Claude and OpenAI)
- Manage tool definitions in provider-specific format
- Handle API calls and authentication
- Parse response back to unified format

**Implementations in v1:
- `ClaudeProvider` - Anthropic Claude Messages API
- `OpenAIProvider` - OpenAI Chat Completions API

### 5. Core Agent Loop (`src/agent.ts`)

**Agent class:**
```typescript
class Agent {
  constructor(config: {
    provider: Provider;
    contextManager: ContextManager;
    middleware?: Middleware[];
  });

  // Run one turn of the agent loop
  run(userMessage: Message): Promise<AgentContext>;

  // Run one turn with streaming
  runStream(userMessage: Message): AsyncIterable<LLMResponseChunk>;

  // Get current context
  getContext(): AgentContext;

  // Clear conversation
  clear(): void;
}
```

**Agent Loop Flow:
1. Add user message to context
2. Run context through composed middleware pipeline (onion)
3. Middleware pipeline ends with provider.invoke() (or stream)
4. Add provider response is added to context
5. Return the final context

## v1 Scope

Minimal v1 includes:
- Core agent loop with onion middleware
- Context management with pluggable compression strategies
- Base `TrimOldestStrategy` compression
- Claude and OpenAI providers with invoke/stream support
- Directory structure ready for: sessions (JSONL), memory, skills, extensions

Minimal v1 *does not* include:
- Full JSONL session implementation (will add later)
- Additional compression strategies (beyond trim)
- Skill system implementation
- Memory implementation

## Extensibility

The design is intentionally structured for future expansion:
- New LLM providers go in `foundation/providers/`
- New memory implementations go in `foundation/memory/`
- Custom middleware goes in `middleware/`
- Skills go in `skills/`
- New compression strategies implement the `CompressionStrategy` interface

## Token Counting

We'll use `@anthropic-ai/tokenizer` for token counting. It works well enough for both Claude and OpenAI models for approximate counting.
