/** Unified token/cost statistics. Missing fields are allowed to be absent. */
export interface Usage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly costUsd?: number;
}

/** Stable core events observed by Product Backend. Backends map their native
 *  events onto this small set; business state machines must not depend on
 *  namespaced extension events. */
export type BackendEvent =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "thinking_delta"; readonly text: string }
  | { readonly type: "product_tool_started"; readonly toolName: string; readonly callId: string }
  | { readonly type: "product_tool_completed"; readonly toolName: string; readonly callId: string }
  | { readonly type: "native_tool_started"; readonly toolName: string; readonly callId: string }
  | { readonly type: "native_tool_completed"; readonly toolName: string; readonly callId: string }
  | { readonly type: "pending_action"; readonly actionId: string }
  | { readonly type: "status"; readonly status: string }
  | { readonly type: "turn_completed" }
  | { readonly type: "turn_failed"; readonly error?: string }
  /** Opaque Backend-specific event. The kind prefix must match the Backend's
   *  `backendKind`; e.g. `backend.coding_agent.*`. Usable for diagnostics or
   *  UI enhancement, never for product state. */
  | { readonly type: `backend.${string}`; readonly payload: Readonly<Record<string, unknown>> };
