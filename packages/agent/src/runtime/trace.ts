/**
 * RunSpan — OTel-style span for run tracing.
 *
 * Framework defines the interface; backend provides the implementation
 * (via `AgentSessionConfig.startSpan`). The framework creates the span
 * at the start of each `run()`/`continue()`/`resume()` and calls
 * `end()` in the `finally` block.
 *
 * The span is opaque to the framework — it doesn't know about
 * `supervisor`, `opsStore`, or any backend concept. It only knows
 * the span identity (`spanId`, `sessionId`) and that `end()` marks
 * the run as finished.
 */
export interface RunSpan {
  /** The run's span ID — unique per prompt()/resume() call. */
  spanId: string;
  /** The session this span belongs to. */
  sessionId: string;
  /**
   * Mark the span as ended. Called by framework in the `finally` block
   * of `run()`/`continue()`/`resume()`.
   *
   * Implementations use this to fire `notifyRunComplete` and clean up
   * active-run tracking. Must be idempotent — safe to call multiple times.
   */
  end(status: "succeeded" | "error" | "interrupted", errorMessage?: string): void;
}
