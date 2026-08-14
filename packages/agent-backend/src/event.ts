/** Unified token/cost statistics. Missing fields are allowed to be absent. */
export interface Usage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly costUsd?: number;
}

/** Stable core events observed by Product Backend. Backends map their native
 *  events onto this small set. Business state machines must never derive a
 *  terminal state from events - `BackendRunOutcome` is the only terminal
 *  authority. UI lifecycle observation uses the open-ended `status` event. */
export type CoreBackendEvent =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "thinking_delta"; readonly text: string }
  | { readonly type: "product_tool_started"; readonly toolName: string; readonly callId: string }
  | {
      readonly type: "product_tool_completed";
      readonly toolName: string;
      readonly callId: string;
      readonly result?: Readonly<Record<string, unknown>>;
    }
  | { readonly type: "native_tool_started"; readonly toolName: string; readonly callId: string }
  | {
      readonly type: "native_tool_completed";
      readonly toolName: string;
      readonly callId: string;
      readonly result?: Readonly<Record<string, unknown>>;
    }
  | { readonly type: "pending_action"; readonly actionId: string }
  | { readonly type: "status"; readonly status: string }
  | {
      readonly type: "workflow_started";
      readonly workflowId: string;
      readonly label: string;
      readonly agentCount: number;
    }
  | {
      readonly type: "workflow_agent_started";
      readonly workflowId: string;
      readonly agentId: string;
      readonly label: string;
    }
  | {
      readonly type: "workflow_agent_completed";
      readonly workflowId: string;
      readonly agentId: string;
      readonly label: string;
      readonly ok: boolean;
      readonly error?: string;
      readonly usage?: unknown;
    }
  | {
      readonly type: "workflow_completed";
      readonly workflowId: string;
      readonly ok: boolean;
      readonly agentCount: number;
      readonly totalTokens: number;
    };

/** Opaque Backend-specific event. The kind segment must match the producing
 *  Backend's `backendKind`; the event segment is Backend-private. Usable for
 *  diagnostics or UI enhancement, never for product state. Parameterized by
 *  `K` so a Backend of kind `K` can only emit `backend.<K>.<event>`. */
export interface BackendExtensionEvent<K extends string> {
  readonly type: `backend.${K}.${string}`;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** The full event union a Backend of kind `K` may emit. `K` defaults to
 *  `string` for the opaque (un-parameterized) consumer. */
export type BackendEvent<K extends string = string> = CoreBackendEvent | BackendExtensionEvent<K>;
