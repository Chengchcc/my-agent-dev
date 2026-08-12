/** Claude Code stream-json stdout event shapes. Captured from a real
 *  claude 2.1.228 run (docs/architecture/execution/backend-kinds-gate0.md).
 *  Only the fields the adapter reads are typed; unknown system subtypes
 *  (thinking_tokens, hook_*, future additions) fall through harmlessly. */

export interface ClaudeContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly thinking?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: unknown;
  readonly content?: unknown;
  readonly tool_use_id?: string;
  readonly is_error?: boolean;
}

export interface ClaudeMessage {
  readonly role?: string;
  readonly model?: string;
  readonly content?: readonly ClaudeContentBlock[];
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly cache_read_input_tokens?: number;
    readonly cache_creation_input_tokens?: number;
  };
}

export interface ClaudeModelUsageEntry {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
}

export type ClaudeEvent =
  | {
      readonly type: "system";
      readonly subtype: string;
      readonly session_id?: string;
    }
  | { readonly type: "assistant"; readonly message?: ClaudeMessage }
  | { readonly type: "user"; readonly message?: ClaudeMessage }
  | {
      readonly type: "result";
      readonly subtype?: string;
      readonly result?: string;
      readonly is_error?: boolean;
      readonly session_id?: string;
      readonly total_cost_usd?: number;
      readonly modelUsage?: Readonly<Record<string, ClaudeModelUsageEntry>>;
    }
  | { readonly type: "error"; readonly error_text?: string };

/** Parse one stdout line into a ClaudeEvent. Malformed/unknown lines return
 *  null — the stream loop skips them. */
export function parseClaudeLine(line: string): ClaudeEvent | null {
  try {
    const obj = JSON.parse(line) as { type?: string };
    if (typeof obj.type !== "string") return null;
    return obj as unknown as ClaudeEvent;
  } catch {
    return null;
  }
}
