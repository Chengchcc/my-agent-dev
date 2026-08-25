import type { AIMessageChunk, JsonSchema, Message } from "@chengchenccc/message";

// ─── Modalities + Cost ───

export type InputModality = "text" | "image";

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// ─── Thinking levels (standardized) ───

export type ThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh";

/** Per-model thinking-level support.
 *  Missing keys use provider defaults. `null` = unsupported level. */
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

// ─── Per-API compat flags (sparse overrides) ───

/** Anthropic Messages API compatibility. */
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
  /** F5: structured-output request (provider-specific wire mapping). */
  responseFormat?: JsonSchema;
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
  /** Quota/billing exhaustion (zai 429 code 1308, insufficient_quota...).
   * Terminal for backoff: waiting seconds will not restore the budget. */
  Quota: "quota",
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
/** Context-overflow error patterns by provider wording (absorbed from
 * oh-my-pi packages/ai/src/utils/overflow.ts — one entry per known provider
 * phrasing; the last two are our original generic nets, kept as fallback).
 * Messages matching NON_OVERFLOW_PATTERNS are excluded even on a partial
 * match: Bedrock throttling says "Too many tokens, please wait". */
const OVERFLOW_PATTERNS: readonly RegExp[] = [
  /prompt is too long/i, // Anthropic token overflow
  /request_too_large/i, // Anthropic byte-size overflow (HTTP 413)
  /input is too long for requested model/i, // Amazon Bedrock
  /exceeds the context window/i, // OpenAI (Completions & Responses)
  /exceeds (?:the )?(?:model'?s )?maximum context length/i, // OpenAI-compatible proxies
  /input token count.*exceeds the maximum/i, // Google (Gemini)
  /maximum prompt length is \d+/i, // xAI (Grok)
  /reduce the length of the messages/i, // Groq
  /maximum context length is \d+ tokens/i, // OpenRouter (most backends)
  /exceeds (?:the )?maximum allowed input length/i, // OpenRouter/Poolside
  /input \(\d+ tokens\) is longer than the model'?s context length/i, // Together AI
  /exceeds the limit of \d+/i, // GitHub Copilot
  /exceeds the available context size/i, // llama.cpp server
  /greater than the context length/i, // LM Studio
  /context window exceeds limit/i, // MiniMax
  /exceeded model token limit/i, // Kimi For Coding
  /too large for model with \d+ maximum context length/i, // Mistral
  /model_context_window_exceeded/i, // zai non-standard finish_reason
  /prompt too long; exceeded (?:max )?context length/i, // Ollama explicit
  /context[_ ]length[_ ]exceeded/i, // generic fallback
  /too many tokens/i, // generic fallback
  /token limit exceeded/i, // generic fallback
  /context.{0,20}(?:length|window|too long)/i, // our original net
  /maximum.{0,20}token/i, // our original net
];

const NON_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /^(?:Throttling error|Service unavailable):/i, // AWS Bedrock (formatted)
  /ThrottlingException/i, // AWS Bedrock (raw)
  /rate limit/i,
  /too many requests/i,
];

/** Quota/billing exhaustion (absorbed from oh-my-pi retry.ts, plus zai's
 * 429 code 1308 usage-window signal). Never backoff-retried. */
const QUOTA_RE =
  /insufficient_quota|quota exceeded|out of budget|billing|usage limit|GoUsageLimitError|FreeUsageLimitError|available balance|code\D{0,4}1308/i;

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
  if (QUOTA_RE.test(msg)) {
    return new ProviderError(msg, "quota", { statusCode: code, detail, ...retryOpts });
  }
  if (code === 400 || code === 413 || code === 422) {
    // Skip known non-overflow wordings (throttling) before pattern matching.
    const nonOverflow = NON_OVERFLOW_PATTERNS.some((p) => p.test(msg));
    if (!nonOverflow && OVERFLOW_PATTERNS.some((p) => p.test(msg))) {
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
