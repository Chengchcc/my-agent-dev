import type { AIMessageChunk } from "@my-agent-team/core";
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

/** 一个 LLM 提供商的运行时定义。Provider 不缓存 credential-bearing ChatModel；
 *  credential 由 ModelRuntime 每次 request resolve 后传入 stream。 */
export interface Provider {
  readonly id: string;
  readonly name: string;
  readonly baseUrl?: string;
  getModels(): readonly Model[];
  stream(
    model: Model,
    messages: readonly Message[],
    opts?: ProviderStreamOptions,
  ): AsyncIterable<AIMessageChunk>;
}

/** Tool schema advertised to a model. Providers only read the schema fields
 *  (name/description/inputSchema) — execution stays in the agent loop, so
 *  the full Tool interface (with execute) is not required here. */
export interface ProviderToolSchema {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
}

/** Per-request provider stream options. Credentials are resolved per request. */
export interface ProviderStreamOptions {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  tools?: readonly ProviderToolSchema[];
  /** Thinking-mode control (Anthropic `thinking` param): adaptive lets the
   *  model decide, enabled uses a budget, disabled turns it off. `display`
   *  controls whether thinking text is returned ("summarized") or omitted
   *  (signature only). */
  thinking?: {
    type: "adaptive" | "enabled" | "disabled";
    display?: "summarized" | "omitted";
    budgetTokens?: number;
  };
  /** Response effort (Anthropic `effort` param): scales how much work the
   *  model puts in, thinking included. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

/** API 类型标识（模型元数据，仅用于 catalog 标记）。 */
export type KnownApi = "anthropic-messages" | "openai-completions";
export type Api = KnownApi | (string & {});

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
  /** Redacted diagnostic message; never the raw error object (which may carry
   *  credential material). */
  readonly detail?: string;

  constructor(
    message: string,
    kind: ProviderErrorKind,
    opts?: { statusCode?: number; detail?: string },
  ) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.statusCode = opts?.statusCode;
    this.detail = opts?.detail;
    this.retryable = kind === "transient" || kind === "overload";
  }
}

const OVERFLOW_RE = /context|too long|maximum|overflow|token limit/i;

/** Normalize a raw provider error into a ProviderError, redacting credential
 *  material from the message. The raw error object is never retained; only the
 *  redacted message survives. Shared by all providers. */
export function normalizeProviderError(
  err: unknown,
  redactSecrets: readonly string[] = [],
): ProviderError {
  let msg = err instanceof Error ? err.message : String(err);
  for (const secret of redactSecrets) {
    if (secret) msg = msg.replaceAll(secret, "[REDACTED]");
  }
  const detail = msg;
  const s = msg.match(/status[= ](\d+)/);
  const code = s ? Number(s[1]) : undefined;
  // Context-length errors (400/422 with body mentioning limits) are overflow,
  // a distinct retryable-after-compaction category from invalid_request.
  if (code === 400 || code === 422) {
    if (OVERFLOW_RE.test(msg)) {
      return new ProviderError(msg, "overflow", { statusCode: code, detail });
    }
    return new ProviderError(msg, "invalid_request", { statusCode: code, detail });
  }
  if (code === 401 || code === 403)
    return new ProviderError(msg, "auth", { statusCode: code, detail });
  if (code === 429) return new ProviderError(msg, "overload", { statusCode: code, detail });
  if (code !== undefined && code >= 500)
    return new ProviderError(msg, "transient", { statusCode: code, detail });
  if (
    msg.includes("fetch") ||
    msg.includes("network") ||
    msg.includes("ECONN") ||
    msg.includes("timeout")
  )
    return new ProviderError(msg, "transient", { detail });
  if (err instanceof DOMException && err.name === "AbortError")
    return new ProviderError(msg, "aborted", { detail });
  return new ProviderError(msg, "fatal", { detail });
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
    opts?: { signal?: AbortSignal; tools?: readonly ProviderToolSchema[] },
  ): AsyncIterable<AIMessageChunk>;
}
