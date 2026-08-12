/** Pi CLI (`pi -p --mode json`) stdout event shapes. Captured from a real
 *  pi 17.2.15 run (docs/architecture/execution/backend-kinds-gate0.md).
 *  Only the fields the adapter reads are typed; unknown fields are ignored
 *  (forward cpiatibility — new event types fall through harmlessly). */

export interface PiUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
  readonly cost?: { readonly total: number };
}

interface PiContentBlock {
  readonly type: string;
  readonly text?: string;
}

export interface PiMessageEvent {
  readonly role: string;
  readonly content?: readonly PiContentBlock[];
  readonly model?: string;
  readonly usage?: PiUsage;
  readonly stopReason?: string;
}

export interface PiAssistantMessageEvent {
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

export interface PiToolResult {
  readonly toolCallId: string;
  readonly toolName?: string;
  readonly content?: readonly PiContentBlock[];
  readonly isError?: boolean;
}

export type PiEvent =
  | { readonly type: "session" }
  | { readonly type: "agent_start" }
  | {
      readonly type: "agent_end";
      readonly messages?: readonly PiMessageEvent[];
      readonly isTerminal?: boolean;
    }
  | { readonly type: "turn_start" }
  | {
      readonly type: "turn_end";
      readonly message?: PiMessageEvent;
      readonly toolResults?: readonly PiToolResult[];
    }
  | { readonly type: "message_start"; readonly message?: PiMessageEvent }
  | { readonly type: "message_end"; readonly message?: PiMessageEvent }
  | {
      readonly type: "message_update";
      readonly assistantMessageEvent?: PiAssistantMessageEvent;
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

/** Parse one stdout line into an PiEvent. Malformed/unknown lines return
 *  null — the stream loop skips them (mirrors solo's pi parser). */
export function parsePiLine(line: string): PiEvent | null {
  try {
    const obj = JSON.parse(line) as { type?: string };
    if (typeof obj.type !== "string") return null;
    return obj as unknown as PiEvent;
  } catch {
    return null;
  }
}
