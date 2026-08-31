# Spec: Multi-API Provider + Model Catalog

## Overview

Refactor `packages/ai` from a single-provider inline architecture to a
SOLID multi-API provider system supporting Anthropic Messages, OpenAI
Chat Completions, and OpenAI Responses protocols, with a declarative
model catalog.

## Architecture

```
createProvider(config)
  └── stream(model, messages, opts)
        ├── getApiImplementation(model.api)     ← OCP: registry lookup
        ├── impl.buildRequest(model, msg, opts) → { url, headers, body }
        ├── fetchSSE(url, headers, body)        ← DIP: shared transport
        └── impl.createChunkConverter()(raw)    ← SRP: decode per-protocol
```

## File Layout

```
packages/ai/src/
  types.ts              Model, ModelSpec, compat interfaces, StreamOptions
  compat.ts             resolveAnthropicCompat, resolveOpenAICompat
  api-registry.ts       ApiImplementation interface + registry
  model-catalog.ts      parseCatalogYAML, BUILTIN_CATALOG, buildModel (no bundled file)
  model-runtime.ts      ModelRuntime (unchanged interface)
  providers/
    shared-sse.ts       fetchSSE transport
    anthropic-messages.ts   ApiImplementation
    openai-completions.ts   ApiImplementation
    openai-responses.ts     ApiImplementation
    create-provider.ts      unified factory
    index.ts                barrel (registers all API modules)
```

## Types

### Model (resolved by buildModel)

```typescript
interface Model {
  id, name, provider, api: Api,
  baseUrl?, reasoning: boolean,
  input: readonly InputModality[],
  cost: ModelCost,
  contextWindow, maxTokens: number,
  thinkingLevelMap?: ThinkingLevelMap,   // per-model level support
  compat?: AnthropicCompat | OpenAICompat, // sparse → resolved at stream time
}
```

### ThinkingLevelMap

```typescript
type ThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh";
type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;
// null = unsupported; string = wire value (identity if same as key)
```

### AnthropicCompat

| Flag | Default | Purpose |
|---|---|---|
| supportsTemperature | true | Claude Opus 4.7+ rejects temperature |
| supportsCacheControlOnTools | true | Some proxies reject it |
| supportsLongCacheRetention | true | 1h TTL support |
| forceAdaptiveThinking | false | Sonnet 4.6+ requires `thinking.type:"adaptive"` |
| allowEmptySignature | false | DeepSeek accepts empty signature |
| supportsEagerToolInputStreaming | true | Per-tool streaming flag |

### OpenAICompat

| Flag | Default | Purpose |
|---|---|---|
| thinkingFormat | "none" | "deepseek" \| "qwen" \| "zai" — how reasoning is sent |
| maxTokensField | "max_tokens" | "max_completion_tokens" for newer OpenAI models |
| supportsReasoningEffort | false | o1/o3 models accept `reasoning_effort` |
| supportsDeveloperRole | true | Newer models use `developer` instead of `system` |

### ProviderStreamOptions (expanded)

```typescript
interface ProviderStreamOptions {
  apiKey?, baseUrl?, headers?, signal?,
  tools?,
  thinking?: { type, display?, budgetTokens? },
  effort?,
  cacheControl?: boolean,
  maxRetries?, maxRetryDelayMs?, timeoutMs?,  // NEW
}
```

## ApiImplementation Interface

```typescript
interface ApiImplementation {
  buildRequest(model, messages, opts): {
    url: string;           // endpoint path
    headers: Record<string, string>;  // API-specific auth + content headers
    body: Record<string, unknown>;    // wire payload
  };
  createChunkConverter(): (raw: Record<string, unknown>) => Generator<AIMessageChunk>;
}
```

Each API module exports its functions and self-registers:

```typescript
registerApi("anthropic-messages", { buildRequest, createChunkConverter });
```

## Model Catalog (runtime config)

```yaml
providers:
  <provider-id>:
    api: <api-type>           # "anthropic-messages" | "openai-completions" | "openai-responses"
    baseUrl: <url>
    apiKeyEnv: <ENV_VAR>
    models:
      - id: <model-id>
        name: <display-name>
        reasoning: <bool>
        input: [text, image?]
        contextWindow: <tokens>
        maxTokens: <tokens>
        cost: { input, output, cacheRead, cacheWrite }
        thinking?:              # optional, only for reasoning models
          mode: effort | budget | adaptive
          efforts: [off, low, high, max]
          defaultLevel?: <level>
          effortMap?: { high: "xhigh" }  # remap to wire values
        compat?:                # sparse overrides, resolved with defaults
          <flag>: <value>
```

## createProvider Factory

```typescript
function createProvider(config: {
  id: string;
  name: string;
  baseUrl: string;
  auth: { apiKey?: string; headers?: Record<string, string> };
  models: readonly Model[];
}): Provider
```

The factory:
1. Creates a Provider whose `stream()` looks up `getApiImplementation(model.api)`
2. Calls `impl.buildRequest()` to get the wire payload + API-specific headers
3. Merges auth credentials into headers
4. Calls `fetchSSE()` for transport
5. Converts chunks via `impl.createChunkConverter()`
6. Wraps errors in `normalizeProviderError()`

## Migration

Old files deleted:
- `anthropic.ts`（旧）→ `anthropic-messages.ts`
- `openai-compat.ts`（旧）→ `openai-completions.ts` / `openai-responses.ts`
- `builtin-providers.ts` → `model-catalog.ts`
- `provider-config.ts` → `model-catalog.ts`

Old factory functions (`anthropicProvider`, `createOpenAICompatProvider`, `customProvider`)
replaced by unified `createProvider()`.

## Acceptance Criteria

1. `bun run build && bun run typecheck && bun run lint && bun run test` all pass
2. Anthropic streaming works unchanged (same wire format, compat-driven)
3. OpenAI Chat Completions streaming works with compat-driven thinking format
4. OpenAI Responses API streaming works (new protocol)
5. Adding a model requires only a models.yml entry
6. Adding an API protocol requires only one new file + one `registerApi()` call
