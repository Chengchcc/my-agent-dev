import type { AIMessageChunk, ChatModel, Tool } from "@my-agent-team/core";
import type { Message } from "@my-agent-team/message";

/** 模型输入模态 */
export type InputModality = "text" | "image";

/** 模型成本（$/million tokens） */
export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Model 元数据对象 - 替代裸字符串。 */
export interface Model {
  id: string;
  name: string;
  provider: string;
  api: Api;
  baseUrl?: string;
  reasoning: boolean;
  input: readonly InputModality[];
  cost: ModelCost;
  contextWindow: number;
  maxTokens: number;
}

/** Provider 认证配置 */
export interface ProviderAuth {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

/** 一个 LLM 提供商的运行时定义。 */
export interface Provider {
  readonly id: string;
  readonly name: string;
  readonly baseUrl?: string;
  getModels(): readonly Model[];
  createModel(model: Model, auth?: ProviderAuth): ChatModel;
}

/** API 类型标识。 */
export type KnownApi = "anthropic-messages" | "openai-completions";
export type Api = KnownApi | (string & {});

/** API 流选项。 */
export interface ApiStreamOptions {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  tools?: readonly Tool[];
}

/** API 实现接口 -- 每个 API 导出一个 stream 函数。 */
export interface ApiImplementation {
  stream(
    model: Model,
    messages: readonly Message[],
    options?: ApiStreamOptions,
  ): AsyncIterable<AIMessageChunk>;
}

// ─── Phase 2: ModelRuntime (provider registry + credential store) ───

/** Normalised provider error categories for retry/no-retry decisions. */
export const ProviderErrorKind = {
  Transient: "transient",
  Overload: "overload",
  Auth: "auth",
  InvalidRequest: "invalid_request",
  Fatal: "fatal",
  Aborted: "aborted",
  Overflow: "overflow",
} as const;
export type ProviderErrorKind = (typeof ProviderErrorKind)[keyof typeof ProviderErrorKind];

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly statusCode?: number;
  readonly retryable: boolean;
  readonly raw?: unknown;

  constructor(
    message: string,
    kind: ProviderErrorKind,
    opts?: { statusCode?: number; raw?: unknown },
  ) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.statusCode = opts?.statusCode;
    this.raw = opts?.raw;
    this.retryable = kind === "transient" || kind === "overload";
  }
}

/** Resolved credential for a model request. */
export interface ResolvedCredential {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

/** Stores and resolves provider credentials. Implementations may read
 *  from env, Vault, or a Product Backend config service. */
export interface CredentialStore {
  resolve(providerId: string): Promise<ResolvedCredential | null>;
}

/** Result of refreshing the model catalog from all registered providers. */
export interface CatalogRefreshResult {
  readonly models: readonly ModelRuntimeEntry[];
  readonly timestamp: number;
}

export interface ModelRuntimeEntry {
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly reasoning: boolean;
  readonly inputModalities: readonly string[];
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly available: boolean;
}
/** Callback that converts a model into a streaming ChatModel. */

/** Phase 2 ModelRuntime: provider registry, credential resolution, catalog,
 *  availability filtering, refresh, and stream dispatch. */
export interface ModelRuntime {
  registerProvider(provider: Provider): void;
  setProvider(provider: Provider): void;
  getProvider(id: string): Provider | undefined;
  resolveModel(
    providerId: string,
    modelId: string,
  ): Promise<{ model: ModelRuntimeEntry; credential: ResolvedCredential }>;
  getCatalog(): Promise<CatalogRefreshResult>;
  refreshCatalog(): Promise<CatalogRefreshResult>;
  stream(
    providerId: string,
    modelId: string,
    messages: readonly Message[],
    opts?: { signal?: AbortSignal; tools?: readonly Tool[] },
  ): AsyncIterable<AIMessageChunk>;
}
