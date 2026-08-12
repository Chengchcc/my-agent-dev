// ─── Side-effect: register all API implementations (OCP) ───
// Each module calls registerApi() at load time. Importing this barrel
// makes all built-in protocols available — no manual registration needed.
import "./providers/anthropic-messages.js";
import "./providers/openai-completions.js";
import "./providers/openai-responses.js";

export type { ApiImplementation } from "./api-registry.js";

// ─── API registry ───
export { getApiImplementation, hasApiImplementation, registerApi } from "./api-registry.js";
// ─── Compat ───
export {
  clampThinkingLevel,
  type ResolvedAnthropicCompat,
  type ResolvedOpenAICompat,
  resolveAnthropicCompat,
  resolveOpenAICompat,
} from "./compat.js";
// ─── Model catalog (runtime config: parseCatalogYAML + BUILTIN_CATALOG) ───
export {
  BUILTIN_CATALOG,
  buildAllModels,
  buildModel,
  type CatalogSpec,
  MODEL_ALIASES,
  type ModelSpec,
  type ProviderSpec,
  parseCatalogYAML,
  resolveModelAlias,
  type ThinkingConfig,
  type ThinkingMode,
} from "./model-catalog.js";
export type { ModelRuntimeOptions } from "./model-runtime.js";

// ─── Model runtime ───
export { createModelRuntime } from "./model-runtime.js";
export type { CreateProviderConfig } from "./providers/create-provider.js";
// ─── Provider factory ───
export { createProvider } from "./providers/create-provider.js";
export type { SSEFetchOpts } from "./providers/shared-sse.js";
// ─── Transport ───
export { fetchSSE } from "./providers/shared-sse.js";
// ─── Types ───
export type {
  AnthropicCompat,
  Api,
  CatalogRefreshResult,
  CredentialStore,
  InputModality,
  KnownApi,
  Model,
  ModelCompat,
  ModelCost,
  ModelRuntime,
  ModelRuntimeEntry,
  OpenAICompat,
  Provider,
  ProviderAuth,
  ProviderErrorKind as ProviderErrorKindType,
  ProviderStreamOptions,
  ProviderToolSchema,
  ResolvedCredential,
  ThinkingLevel,
  ThinkingLevelMap,
} from "./types.js";
export { normalizeProviderError, ProviderError, ProviderErrorKind } from "./types.js";
