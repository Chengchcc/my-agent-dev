import type { Message } from "./message.js";
import type { Tool } from "./tool.js";

export interface AIMessageChunk {
  delta?:
    | { type: "text"; text: string }
    | { type: "reasoning"; text: string }
    | { type: "reasoning_signature"; signature: string; redacted?: boolean }
    | { type: "tool_use"; id: string; name: string }
    | { type: "input_json_delta"; id: string; partial_json: string };
  done?: boolean;
  stopReason?: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "pause_turn" | "refusal";
  usage?: { input?: number; output: number; cacheCreate?: number; cacheRead?: number };
}

/** Structured-output request (F5): ask the provider to generate JSON
 *  conforming to `schema` instead of free text. */
export interface JsonSchema {
  readonly name: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly strict?: boolean;
}

export interface ChatModelOptions {
  signal?: AbortSignal;
  tools?: readonly Tool[];
  responseFormat?: JsonSchema;
}

export interface ChatModel {
  readonly id?: string;
  stream(messages: readonly Message[], options?: ChatModelOptions): AsyncIterable<AIMessageChunk>;
  countTokens?(messages: readonly Message[]): number | Promise<number>;
}
