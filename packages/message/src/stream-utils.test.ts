import { describe, expect, test } from "bun:test";
import type { AIMessageChunk } from "./chat-model.js";
import { collectStream } from "./stream-utils.js";

async function* chunks(): AsyncIterable<AIMessageChunk> {
  yield { delta: { type: "text", text: "hello " } };
  yield { delta: { type: "text", text: "world" } };
  yield { delta: { type: "tool_use", id: "toolu_1", name: "lookup" } };
  yield { delta: { type: "input_json_delta", id: "toolu_1", partial_json: '{"q":' } };
  yield { delta: { type: "input_json_delta", id: "toolu_1", partial_json: '"weather"}' } };
  yield { done: true, stopReason: "tool_use", usage: { input: 3, output: 5 } };
}

describe("collectStream", () => {
  test("collects streamed deltas into blocks and preserves completion metadata", async () => {
    const result = await collectStream(chunks());

    expect(result).toEqual({
      blocks: [
        { type: "text", text: "hello world" },
        { type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "weather" } },
      ],
      stopReason: "tool_use",
      usage: { input: 3, output: 5 },
    });
  });
});
