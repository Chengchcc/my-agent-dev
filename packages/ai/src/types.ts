import type { AIMessageChunk } from "@my-agent-team/core";
import type { Message } from "@my-agent-team/message";

// ─── Modalities + Cost ───

export type InputModality = "text" | "image";

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// ─── Thinking levels (pi/omp aligned) ───

export type ThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh";

/** Per-model thinking-level support (pi: ThinkingLevelMap).
 *  Missing keys use provider defaults. `null` = unsupported level. */
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

// ─── Per-API compat flags (pi/omp pattern: sparse overrides) ───

/** Anthropic Messages API compatibility (pi: AnthropicMessagesCompat). */
export interface AnthropicCompat {
  readonly supportsTemperature?: boolean;
  readonly supportsCacheControlOnTools?: boolean;
  readonly supportsLongCacheRetention?: boolean;
  readonly forceAdaptiveThinking?: boolean;
  readonly allowEmptySignature?: boolean;
  readonly supportsEagerToolInputStreaming?: boolean;
}

/** OpenAI Chat Completions + Responses API compatibility. */
export interface OpenAICompat {
  /** How reasoning/thinking is sent on the wire.
   *  - "none": no reasoning param (standard GPT-4o etc.)
   *  - "deepseek": `thinking: { type: "enabled"|"disabled" }`
   *  - "qwen": `enable_thinking: boolean`
   *  - "zai": `thinking: {type}` + `reasoning_effort`
   *  - "openrouter": `reasoning: { effort }`  */
  readonly thinkingFormat?: "none" | "deepseek" | "qwen" | "zai" | "openrouter";
  /** "max_tokens" (legacy) or "max_completion_tokens" (newer OpenAI). */
  readonly maxTokensField?: "max_tokens" | "max_completion_tokens";
  /** Whether `reasoning_effort` param is accepted (o1/o3 models). */
  readonly supportsReasoningEffort?: boolean;
  /** Whether `developer` role is accepted instead of `system`. */
  readonly supportsDeveloperRole?: boolean;
}

export type ModelCompat = AnthropicCompat | OpenAICompat;

// ─── Model ───

export interface Model {
  id: string;
  name: string;
  provider: string;
  api: Api;
  baseUrl?: string;
  reasoning: boolean;
  readonly thinkingLevelMap?: ThinkingLevelMap;
  input: readonly InputModality[];
  cost: ModelCost;
  contextWindow: number;
  maxTokens: number;
  readonly compat?: ModelCompat;
}

// ─── Provider + stream options ───

export type KnownApi = "anthropic-messages" | "openai-completions" | "openai-responses";
export type Api = KnownApi | (string & {});

export interface ProviderAuth {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

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

export interface ProviderToolSchema {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
}

export interface ProviderStreamOptions {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  tools?: readonly ProviderToolSchema[];
  thinking?: {
    type: "adaptive" | "enabled" | "disabled";
    display?: "summarized" | "omitted";
    budgetTokens?: number;
  };
  effort?: Exclude<ThinkingLevel, "off">;
  cacheControl?: boolean;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  timeoutMs?: number;
}

// ─── Error normalization ───

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
  readonly retryAfterMs?: number;
  readonly detail?: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    kind: ProviderErrorKind,
    opts?: { statusCode?: number; detail?: string; retryAfterMs?: number },
  ) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.statusCode = opts?.statusCode;
    this.retryAfterMs = opts?.retryAfterMs;
    this.detail = opts?.detail;
    this.retryable = kind === "transient" || kind === "overload";
  }
}

const OVERFLOW_RE = /context|too long|maximum|overflow|token limit/i;

export function normalizeProviderError(
  err: unknown,
  redactSecrets: readonly string[] = [],
): ProviderError {
  let msg = err instanceof Error ? err.message : String(err);
  for (const secret of redactSecrets) {
    if (secret) msg = msg.replaceAll(secret, "[REDACTED]");
  }
  const detail = msg;
  const retryAfterMs = (err as Error & { retryAfterMs?: number }).retryAfterMs;
  const retryOpts = retryAfterMs !== undefined ? { retryAfterMs } : {};
  if (err instanceof Error && err.name === "AbortError") {
    return new ProviderError(msg, "aborted", { detail });
  }
  const s = msg.match(/status[= ](\d+)/);
  const code = s ? Number(s[1]) : undefined;
  if (code === 400 || code === 422) {
    if (OVERFLOW_RE.test(msg)) {
      return new ProviderError(msg, "overflow", { statusCode: code, detail, ...retryOpts });
    }
    return new ProviderError(msg, "invalid_request", { statusCode: code, detail, ...retryOpts });
  }
  if (code === 401 || code === 403)
    return new ProviderError(msg, "auth", { statusCode: code, detail, ...retryOpts });
  if (code === 429)
    return new ProviderError(msg, "overload", { statusCode: code, detail, ...retryOpts });
  if (code !== undefined && code >= 500)
    return new ProviderError(msg, "transient", { statusCode: code, detail, ...retryOpts });
  if (
    msg.includes("fetch") ||
    msg.includes("network") ||
    msg.includes("ECONN") ||
    msg.includes("timeout")
  )
    return new ProviderError(msg, "transient", { detail, ...retryOpts });
  return new ProviderError(msg, "fatal", { detail });
}

// ─── Credential + ModelRuntime ───

export interface ResolvedCredential {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

export interface CredentialStore {
  resolve(providerId: string): Promise<ResolvedCredential | null>;
}

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
  readonly cost: ModelCost;
}

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
    opts?: ProviderStreamOptions,
  ): AsyncIterable<AIMessageChunk>;
}
