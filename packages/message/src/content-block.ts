export interface TextBlock {
  type: "text";
  text: string;
}

/** Model internal monologue (Anthropic extended thinking). Persisted inside
 *  assistant messages so the reasoning trace can show it in order; replayed
 *  back to the API unchanged (with signature) in tool-use turns. Never
 *  rendered as conversation text. */
export interface ThinkingBlock {
  type: "thinking";
  text: string;
  /** Encrypted reasoning signature (Anthropic); must be replayed unchanged.
   *  Absent on endpoints that don't emit one (e.g. DeepSeek). */
  signature?: string;
  /** Safety-redacted thinking: text is a placeholder, `signature` holds the
   *  opaque payload to replay as `redacted_thinking`. */
  redacted?: boolean;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;
