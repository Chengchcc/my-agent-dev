# ADR 0018: Multi-API Provider Architecture

## Status

Proposed

## Context

The current provider layer (`packages/ai`) has:
- One hardcoded `anthropicProvider()` factory with inline fetch+SSE+error handling
- One `openai-compat.ts` with a different inline pattern (no compat flags, no thinking support)
- Flat `ModelCompat` (4 fields) that no provider consumes
- Hand-written `ANTHROPIC_MODELS` array (code, not data)
- `ModelRuntime` as provider registry with `registerProvider`/`setProvider`

Adding OpenAI Responses API support or a new provider requires duplicating
the fetch+SSE+auth+error boilerplate and modifying the factory — violating
OCP. Thinking/reasoning support differs per API (Anthropic adaptive thinking,
DeepSeek `reasoning_content`, OpenAI `reasoning_effort`) but there is no
mechanism to express these differences declaratively.

Pi and omp solve this with:
1. **Per-API compat flags** consumed by a `buildRequest` function
2. **ApiImplementation registry** — each API self-registers, factory dispatches by `model.api`
3. **Declarative model catalog** (`models.json`) loaded at startup, resolved by `buildModel`
4. **Shared streaming transport** — fetch+SSE separated from request/response shaping

## Decision

Adopt a SOLID multi-API provider architecture:

### 1. ApiImplementation registry (OCP)

```typescript
interface ApiImplementation {
  buildRequest(model, messages, opts): { url, headers, body };
  createChunkConverter(): (raw) => Generator<AIMessageChunk>;
}
```

Each API module (`anthropic-messages.ts`, `openai-completions.ts`, `openai-responses.ts`)
self-registers via `registerApi(api, impl)`. Adding a new API = new file + one
`registerApi()` call. No existing file changes.

### 2. Unified createProvider factory (DIP)

```typescript
function createProvider(config): Provider {
  return {
    ...,
    async *stream(model, messages, opts) {
      const impl = getApiImplementation(model.api);
      const { url, headers, body } = impl.buildRequest(model, messages, opts);
      // shared SSE transport, shared error normalization
    }
  };
}
```

Provider depends on `ApiImplementation` interface + `StreamTransport` abstraction.
No switch statements, no concrete module imports.

### 3. Per-API compat with defaults resolver (SRP)

```typescript
interface AnthropicCompat {
  supportsTemperature?, supportsCacheControlOnTools?, forceAdaptiveThinking?, ...
}
interface OpenAICompat {
  thinkingFormat?: "none" | "deepseek" | "qwen" | "zai",
  maxTokensField?: "max_tokens" | "max_completion_tokens",
  supportsReasoningEffort?, supportsDeveloperRole?
}
```

`resolveCompat(model)` merges sparse model compat with safe defaults (OMP pattern).
`buildRequest` consumes resolved compat — no runtime if/else on model identity.

### 4. Declarative models.yml catalog (data, not code)

```yaml
providers:
  anthropic:
    api: anthropic-messages
    baseUrl: https://api.anthropic.com/v1
    apiKeyEnv: ANTHROPIC_API_KEY
    models:
      - id: claude-sonnet-4-6
        thinking: { mode: adaptive, efforts: [off, low, high, max] }
        compat: { forceAdaptiveThinking: true }
```

`buildModel(providerId, api, baseUrl, spec)` resolves sparse specs into full
`Model` objects. Adding a model = one YAML entry.

### 5. Shared StreamTransport (DIP)

`fetchSSE(opts)` handles HTTP fetch + SSE line splitting. Never inspects event
content — that's `ApiImplementation`'s job. Tests can inject a mock transport.

## Consequences

**Positive:**
- Adding OpenAI Responses API = new file, zero changes to existing files
- Adding a new provider = YAML entry + optional compat flags
- Each module has one reason to change (SRP)
- Tests can mock transport without mocking fetch

**Negative:**
- One more layer of indirection (registry lookup per stream call)
- YAML parser adds ~100 lines (no dependency — hand-written for our subset)
- Migration of existing callers required

## Alternatives Considered

1. **SDK per API (pi approach)**: Import `openai` + `@anthropic-ai/sdk`. Rejected:
   adds 2 heavy deps, SDK abstractions hide protocol details we need (cache_control,
   thinking, signature replay).

2. **Switch statement in factory**: `switch(model.api) { case "anthropic-messages": ... }`.
   Rejected: violates OCP — every new API modifies the switch.

3. **Keep openai-compat.ts as-is**: Rejected: no compat support, no thinking support,
   inline everything — can't extend without rewriting.
