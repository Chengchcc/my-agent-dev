import { describe, expect, test } from "bun:test";
import {
  anthropicModel,
  collectChunks,
  DONE,
  makeProvider,
  mockFetch,
  openaiModel,
  sseData,
  sseRes,
} from "./provider-contract.fixture.js";

describe("Provider contract — anthropic stream decoding", () => {
  test("tool_use pairs input_json_delta with tool id", async () => {
    const provider = makeProvider(anthropicModel);
    const sse = sseRes([
      sseData({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_1", name: "read" },
      }),
      sseData({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"path":"a' },
      }),
      sseData({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '.ts"}' },
      }),
      sseData({ type: "content_block_stop", index: 0 }),
      DONE,
    ]);
    const restore = mockFetch(sse);
    const chunks = await collectChunks(
      provider.stream(anthropicModel, [{ role: "user", text: "hi" }], { apiKey: "test-key" }),
    );
    restore();

    const toolUse = chunks.find((c) => c.delta?.type === "tool_use");
    expect(toolUse).toBeTruthy();
    expect(toolUse?.delta?.type === "tool_use" && toolUse.delta.id).toBe("toolu_1");

    const deltas = chunks.filter((c) => c.delta?.type === "input_json_delta");
    expect(deltas).toHaveLength(2);
    expect(
      deltas.every((d) => d.delta?.type === "input_json_delta" && d.delta.id === "toolu_1"),
    ).toBe(true);
    const json = deltas
      .map((d) => (d.delta?.type === "input_json_delta" ? d.delta.partial_json : ""))
      .join("");
    expect(json).toBe('{"path":"a.ts"}');
  });
});

describe("Provider contract — openai stream decoding", () => {
  test("tool_calls: first chunk carries id+name, arguments pair by id", async () => {
    const provider = makeProvider(openaiModel);
    const sse = sseRes([
      sseData({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "echo", arguments: "" },
                },
              ],
            },
          },
        ],
      }),
      sseData({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"x":' } }] } }],
      }),
      sseData({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] } }],
      }),
      sseData({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      DONE,
    ]);
    const restore = mockFetch(sse);
    const chunks = await collectChunks(
      provider.stream(openaiModel, [{ role: "user", text: "hi" }], { apiKey: "test-key" }),
    );
    restore();

    const toolUse = chunks.find((c) => c.delta?.type === "tool_use");
    expect(toolUse).toBeTruthy();
    expect(toolUse?.delta?.type === "tool_use" && toolUse.delta.id).toBe("call_1");
    expect(toolUse?.delta?.type === "tool_use" && toolUse.delta.name).toBe("echo");

    const deltas = chunks.filter((c) => c.delta?.type === "input_json_delta");
    expect(deltas).toHaveLength(2);
    expect(
      deltas.every((d) => d.delta?.type === "input_json_delta" && d.delta.id === "call_1"),
    ).toBe(true);
    const json = deltas
      .map((d) => (d.delta?.type === "input_json_delta" ? d.delta.partial_json : ""))
      .join("");
    expect(json).toBe('{"x":1}');

    // No empty-id tool_use for argument-only chunks
    const empties = chunks.filter(
      (c) => c.delta?.type === "tool_use" && !(c.delta as { id: string }).id,
    );
    expect(empties).toHaveLength(0);
  });

  test("multiple tool calls in one chunk each get correct id", async () => {
    const provider = makeProvider(openaiModel);
    const sse = sseRes([
      sseData({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_a",
                  type: "function",
                  function: { name: "read", arguments: "" },
                },
                {
                  index: 1,
                  id: "call_b",
                  type: "function",
                  function: { name: "bash", arguments: "" },
                },
              ],
            },
          },
        ],
      }),
      sseData({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '{"path":"a"}' } },
                { index: 1, function: { arguments: '{"cmd":"pwd"}' } },
              ],
            },
          },
        ],
      }),
      sseData({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      DONE,
    ]);
    const restore = mockFetch(sse);
    const chunks = await collectChunks(
      provider.stream(openaiModel, [{ role: "user", text: "hi" }], { apiKey: "test-key" }),
    );
    restore();

    const toolUses = chunks.filter((c) => c.delta?.type === "tool_use");
    expect(toolUses).toHaveLength(2);
    expect((toolUses[0]!.delta as { id: string }).id).toBe("call_a");
    expect((toolUses[1]!.delta as { id: string }).id).toBe("call_b");

    const deltas = chunks.filter((c) => c.delta?.type === "input_json_delta");
    expect(deltas).toHaveLength(2);
    expect((deltas[0]!.delta as { id: string }).id).toBe("call_a");
    expect((deltas[1]!.delta as { id: string }).id).toBe("call_b");
  });

  test("survives SSE lines split across network chunks", async () => {
    const provider = makeProvider(openaiModel);
    const full = `data: ${JSON.stringify({ choices: [{ delta: { content: "hello-world" } }] })}\n\n${DONE}\n`;
    const cut = Math.floor(full.length / 2);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(full.slice(0, cut)));
        controller.enqueue(new TextEncoder().encode(full.slice(cut)));
        controller.close();
      },
    });
    const restore = mockFetch(
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
    const chunks = await collectChunks(
      provider.stream(openaiModel, [{ role: "user", text: "hi" }], { apiKey: "test-key" }),
    );
    restore();

    const text = chunks
      .filter((c) => c.delta?.type === "text")
      .map((c) => (c.delta?.type === "text" ? c.delta.text : ""))
      .join("");
    expect(text).toBe("hello-world");
  });
});
