export interface ToolExecuteResult {
  content: string;
  isError?: boolean;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /** Declare whether a tool can safely run concurrently with other tools.
   *  "serial" (default) = must run alone, preserving existing behaviour.
   *  "concurrent" = read-only, no side effects, safe to run in parallel
   *  with other concurrent tools in the same turn. */
  readonly executionMode?: "serial" | "concurrent";
  execute(
    input: unknown,
    signal?: AbortSignal,
    /** Per-call execution context from the loop: the model tool-use id when
     *  the call originated from the model (stable idempotency identity). */
    options?: {
      callId?: string;
      /** Streaming partial output (e.g. bash stdout) for live display. */
      onOutput?: (partial: string) => void;
    },
  ): ToolExecuteResult | Promise<ToolExecuteResult>;
}
