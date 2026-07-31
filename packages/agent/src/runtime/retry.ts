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
    attempt++;
    await opts.onRetryStart?.(attempt);
    // Buffer this attempt's output; only forward it once the attempt completes
    // cleanly. A failed attempt's partial output is discarded so it can never
    // contaminate the canonical transcript.
    const buffered: AIMessageChunk[] = [];
    try {
      for await (const chunk of streamFactory(signal)) {
        buffered.push(chunk);
      }
    } catch (err) {
      lastError = err;
      await opts.onRetryEnd?.(attempt);
      if (err instanceof ProviderError && err.retryable && attempt < opts.maxAttempts) {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, opts.baseDelayMs * 2 ** (attempt - 1));
        await promise;
        continue;
      }
      throw err;
    }
    await opts.onRetryEnd?.(attempt);
    // Attempt succeeded atomically: emit the whole buffered turn.
    for (const chunk of buffered) yield chunk;
    return;
  }
  throw lastError;
}
