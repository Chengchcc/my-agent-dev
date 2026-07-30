// API layer - must be imported first to register APIs
import "./api/index.js";

export {
  anthropicMessagesApi,
  getApiImplementation,
  openAICompletionsApi,
  parseSSE,
  registerApi,
} from "./api/index.js";
export type { ModelConfig, ProviderConfig } from "./builtin-providers.js";
export type { ModelRuntimeOptions } from "./model-runtime.js";
// Phase 2: new ModelRuntime
export { createModelRuntime } from "./model-runtime.js";
export { BUILTIN_PROVIDERS, buildModels, loadProvider } from "./provider-config.js";
export {
  ANTHROPIC_MODELS,
  anthropicProvider,
  type CustomProviderConfig,
  createOpenAICompatProvider,
  customProvider,
  deepseekProvider,
  type OpenAICompatProviderConfig,
} from "./providers/index.js";
export type {
  Api,
  ApiImplementation,
  ApiStreamOptions,
  CatalogRefreshResult,
  CredentialStore,
  InputModality,
  KnownApi,
  Model,
  ModelCost,
  ModelRuntime,
  ModelRuntimeEntry,
  Provider,
  ProviderAuth,
  ResolvedCredential,
} from "./types.js";
export { ProviderError, ProviderErrorKind } from "./types.js";
