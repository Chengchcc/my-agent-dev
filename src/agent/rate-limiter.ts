import type { Provider, AgentContext, LLMResponse, LLMResponseChunk } from '../types';
import { debugLog } from '../utils/debug';

const MS_PER_SECOND = 1000;
const DEFAULT_RPS = 5;
const MIN_BURST_SIZE = 3;

/**
 * Token-bucket rate limiter for API calls.
 * Used to prevent rate-limit errors when multiple sub-agents run concurrently.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per second

  constructor(maxTokens: number, refillRate: number) {
    this.maxTokens = maxTokens;
    this.tokens = maxTokens;
    this.refillRate = refillRate;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / MS_PER_SECOND;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }

  async acquire(): Promise<void> {
    // Loop until a token is available — handles concurrent waiters correctly
    while (true) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil(((1 - this.tokens) / this.refillRate) * MS_PER_SECOND);
      debugLog(`[rate-limiter] Throttling for ${waitMs}ms (tokens: ${this.tokens.toFixed(2)})`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }
}

/**
 * Provider wrapper that adds token-bucket rate limiting and optional log prefix.
 * Used by sub-agents to prevent concurrent requests from exceeding API rate limits.
 */
export class RateLimitedProvider implements Provider {
  private bucket: TokenBucket;
  private prefix: string;

  constructor(
    private inner: Provider,
    options: { maxConcurrent?: number; requestsPerSecond?: number; prefix?: string },
  ) {
    const rps = options.requestsPerSecond ?? DEFAULT_RPS;
    const burst = options.maxConcurrent ?? Math.max(MIN_BURST_SIZE, Math.ceil(rps / 2));
    this.bucket = new TokenBucket(burst, rps);
    this.prefix = options.prefix ? `[sub-${options.prefix}] ` : '';
  }

  registerTools(tools: Parameters<Provider['registerTools']>[0]): void {
    this.inner.registerTools(tools);
  }

  async invoke(context: AgentContext): Promise<LLMResponse> {
    await this.bucket.acquire();
    debugLog(`${this.prefix}Provider.invoke called`);
    return this.inner.invoke(context);
  }

  async *stream(
    context: AgentContext,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<LLMResponseChunk> {
    await this.bucket.acquire();
    debugLog(`${this.prefix}Provider.stream started`);
    try {
      for await (const chunk of this.inner.stream(context, options)) {
        yield chunk;
      }
    } finally {
      debugLog(`${this.prefix}Provider.stream ended`);
    }
  }

  getModelName(): string {
    return this.inner.getModelName();
  }
}
