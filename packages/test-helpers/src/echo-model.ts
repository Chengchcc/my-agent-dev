import type { AIMessageChunk, ChatModel } from "@chengchenccc/core";
import type { Message } from "@chengchenccc/message";

export interface EchoScript {
  turns: Array<
    { type: "text"; text: string } | { type: "tool_call"; id: string; name: string; input: unknown }
  >;
}

export function echoModel(script: EchoScript): ChatModel {
  return {
    id: "echo",
    async *stream(messages: readonly Message[]): AsyncIterable<AIMessageChunk> {
      const turn = messages.filter((message) => message.role === "assistant").length;
      const item = script.turns[Math.min(turn, script.turns.length - 1)];
      if (item === undefined) {
        return;
      }

      if (item.type === "text") {
        yield { delta: { type: "text", text: item.text } };
        yield { done: true, stopReason: "end_turn" };
        return;
      }

      yield { delta: { type: "tool_use", id: item.id, name: item.name } };
      yield {
        delta: {
          type: "input_json_delta",
          id: item.id,
          partial_json: JSON.stringify(item.input),
        },
      };
      yield { done: true, stopReason: "tool_use" };
    },
  };
}
