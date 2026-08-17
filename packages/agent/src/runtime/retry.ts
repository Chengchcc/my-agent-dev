import { ProviderError } from "@chengchenccc/ai";
import type { AIMessageChunk } from "@chengchenccc/core";

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
 *  Meta/Prompt/history in the tree).
 *
 *  Streaming is real-time: chunks are forwarded immediately, not buffered.
 *  Retry is only permitted when the attempt has produced ZERO output (a
 *  transient connection error before the first token). Once the first chunk
 *  is emitted the attempt is committed — a later failure makes the Run fail,
 *  never produces a partial "AAB" contamination. */
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
    let committed = false; // becomes true on the first forwarded chunk
    try {
      for await (const chunk of streamFactory(signal)) {
        committed = true;
        yield chunk;
      }
    } catch (err) {
      lastError = err;
      await opts.onRetryEnd?.(attempt);
      // Only retry if the attempt produced zero output AND the error is
      // a retryable transient provider error. A committed attempt that
      // fails mid-stream cannot be retried (partial output already emitted).
      const canRetry =
        !committed && err instanceof ProviderError && err.retryable && attempt < opts.maxAttempts;
      if (canRetry) {
        // Server-requested delay (Retry-After header) takes precedence over
        // our own backoff. Fall back to full-jitter exponential
        // backoff capped at 60s when the server doesn't suggest a delay.
        const serverDelay = err.retryAfterMs;
        const backoff = opts.baseDelayMs * 2 ** (attempt - 1);
        const cappedBackoff = Math.min(backoff, 60_000);
        const delay =
          serverDelay !== undefined ? Math.min(serverDelay, 60_000) : Math.random() * cappedBackoff;
        const { promise, resolve } = Promise.withResolvers<void>();
        const timer = setTimeout(resolve, delay);
        const onAbort = () => resolve();
        if (signal?.aborted) resolve();
        signal?.addEventListener("abort", onAbort, { once: true });
        await promise;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        continue;
      }
      throw err;
    }
    await opts.onRetryEnd?.(attempt);
    return;
  }
  throw lastError;
}
