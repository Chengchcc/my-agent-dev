import { ProviderError } from "@my-agent-team/ai";
import type { AIMessageChunk } from "@my-agent-team/core";

export interface RetryOptions {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
}

/** Wrap a model stream with provider-only retry. Only normalized transient
 *  errors from ProviderError are retried. Tool/business/overflow/auth errors
 *  pass through immediately. The same input messages are reused (no duplicate
 *  Meta/Prompt/history in the tree). */
export async function* retryStream(
  streamFactory: (signal?: AbortSignal) => AsyncIterable<AIMessageChunk>,
  opts: RetryOptions,
): AsyncIterable<AIMessageChunk> {
  let attempt = 0;
  let lastError: unknown;

  while (attempt < opts.maxAttempts) {
    try {
      attempt++;
      yield* streamFactory();
      return;
    } catch (err) {
      lastError = err;
      if (err instanceof ProviderError && err.retryable && attempt < opts.maxAttempts) {
        await new Promise((r) => setTimeout(r, opts.baseDelayMs * 2 ** (attempt - 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}
