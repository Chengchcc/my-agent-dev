import type { Message } from "@my-agent-team/message";
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
  usage?: { input: number; output: number; cacheCreate?: number; cacheRead?: number };
}

export interface ChatModelOptions {
  signal?: AbortSignal;
  tools?: readonly Tool[];
}

export interface ChatModel {
  readonly id?: string;
  stream(messages: readonly Message[], options?: ChatModelOptions): AsyncIterable<AIMessageChunk>;
  countTokens?(messages: readonly Message[]): number | Promise<number>;
}
