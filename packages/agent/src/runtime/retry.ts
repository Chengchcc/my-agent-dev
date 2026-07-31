import { ProviderError } from "@my-agent-team/ai";
import type { AIMessageChunk } from "@my-agent-team/core";

export interface RetryOptions {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  /** Lifecycle callbacks so the loop can emit retry_start/retry_end. */
  readonly onRetryStart?: (attempt: number) => void | Promise<void>;
  readonly onRetryEnd?: (attempt: number) => void | Promise<void>;
}

/** Wrap a model stream with provider-only retry. Only normalized transient
 *  errors from ProviderError are retried. Tool/business/overflow/auth errors
 *  pass through immediately. The same input messages are reused (no duplicate
 *  Meta/Prompt/history in the tree). */
export async function* retryStream(
  streamFactory: (signal?: AbortSignal) => AsyncIterable<AIMessageChunk>,
  opts: RetryOptions,
  signal?: AbortSignal,
): AsyncIterable<AIMessageChunk> {
  let attempt = 0;
  let lastError: unknown;

  while (attempt < opts.maxAttempts) {
    if (signal?.aborted) throw new Error("Aborted");
    try {
      attempt++;
      await opts.onRetryStart?.(attempt);
      yield* streamFactory(signal);
      return;
    } catch (err) {
      lastError = err;
      if (err instanceof ProviderError && err.retryable && attempt < opts.maxAttempts) {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, opts.baseDelayMs * 2 ** (attempt - 1));
        await promise;
        continue;
      }
      throw err;
    } finally {
      await opts.onRetryEnd?.(attempt);
    }
  }
  throw lastError;
}
