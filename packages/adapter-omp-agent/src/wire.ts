/** Omp CLI (`omp -p --mode json`) stdout event shapes. Captured from a real
 *  omp 17.2.15 run (docs/architecture/execution/backend-kinds-gate0.md).
 *  Only the fields the adapter reads are typed; unknown fields are ignored
 *  (forward compatibility — new event types fall through harmlessly). */

export interface OmpUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
  readonly cost?: { readonly total: number };
}

interface OmpContentBlock {
  readonly type: string;
  readonly text?: string;
}

export interface OmpMessageEvent {
  readonly role: string;
  readonly content?: readonly OmpContentBlock[];
  readonly model?: string;
  readonly usage?: OmpUsage;
  readonly stopReason?: string;
}

export interface OmpAssistantMessageEvent {
  readonly type:
    | "thinking_start"
    | "thinking_delta"
    | "thinking_end"
    | "text_start"
    | "text_delta"
    | "text_end";
  readonly contentIndex?: number;
  readonly delta?: string;
  readonly content?: string;
}

export interface OmpToolResult {
  readonly toolCallId: string;
  readonly toolName?: string;
  readonly content?: readonly OmpContentBlock[];
  readonly isError?: boolean;
}

export type OmpEvent =
  | { readonly type: "session" }
  | { readonly type: "agent_start" }
  | {
      readonly type: "agent_end";
      readonly messages?: readonly OmpMessageEvent[];
      readonly isTerminal?: boolean;
    }
  | { readonly type: "turn_start" }
  | {
      readonly type: "turn_end";
      readonly message?: OmpMessageEvent;
      readonly toolResults?: readonly OmpToolResult[];
    }
  | { readonly type: "message_start"; readonly message?: OmpMessageEvent }
  | { readonly type: "message_end"; readonly message?: OmpMessageEvent }
  | {
      readonly type: "message_update";
      readonly assistantMessageEvent?: OmpAssistantMessageEvent;
    }
  | {
      readonly type: "tool_execution_start";
      readonly toolCallId?: string;
      readonly toolName?: string;
      readonly args?: unknown;
    }
  | {
      readonly type: "tool_execution_update";
      readonly toolCallId?: string;
      readonly toolName?: string;
      readonly partialResult?: unknown;
    }
  | {
      readonly type: "tool_execution_end";
      readonly toolCallId?: string;
      readonly toolName?: string;
      readonly result?: unknown;
      readonly isError?: boolean;
    }
  | { readonly type: "error"; readonly message?: unknown }
  | { readonly type: "auto_retry_end"; readonly success?: boolean; readonly finalError?: unknown };

/** Parse one stdout line into an OmpEvent. Malformed/unknown lines return
 *  null — the stream loop skips them (mirrors solo's pi parser). */
export function parseOmpLine(line: string): OmpEvent | null {
  try {
    const obj = JSON.parse(line) as { type?: string };
    if (typeof obj.type !== "string") return null;
    return obj as unknown as OmpEvent;
  } catch {
    return null;
  }
}
