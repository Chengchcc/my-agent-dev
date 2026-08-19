import { describe, expect, test } from "bun:test";

// Side-effect: register all API implementations.
import "./anthropic-messages.js";
import "./openai-completions.js";
import "./openai-responses.js";

import type { AIMessageChunk } from "@chengchenccc/core";
import { type Model, ProviderError } from "../types.js";
import { createProvider } from "./create-provider.js";

// ── Test models ──

const anthropicModel: Model = {
  id: "test-claude",
  name: "Test Claude",
  provider: "anthropic",
  api: "anthropic-messages",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 4096,
};

const openaiModel: Model = {
  id: "test-gpt",
  name: "Test GPT",
  provider: "openai",
  api: "openai-completions",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
};

function makeProvider(model: Model, apiKey = "test-key") {
  return createProvider({
    id: model.provider,
    name: model.provider,
    baseUrl: "https://test.example.com",
    auth: { apiKey },
    models: [model],
  });
}

// ── Fetch mock helpers ──

function mockFetch(response: Response): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(response)) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function mockFetchCapture(response: Response): {
  restore: () => void;
  getBody: () => Record<string, unknown> | null;
} {
  const original = globalThis.fetch;
  let capturedBody: Record<string, unknown> | null = null;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.body) capturedBody = JSON.parse(String(init.body));
    return response;
  }) as unknown as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    getBody: () => capturedBody,
  };
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseRes(lines: string[]): Response {
  return new Response(lines.join("\n"), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function collectChunks(stream: AsyncIterable<AIMessageChunk>): Promise<AIMessageChunk[]> {
  const out: AIMessageChunk[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

async function drainAndCaptureError(stream: AsyncIterable<AIMessageChunk>): Promise<unknown> {
  try {
    for await (const _ of stream) {
      /* drain */
    }
    return null;
  } catch (e) {
    return e;
  }
}

// ── SSE line builders ──

function sseData(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}`;
}

const DONE = "data: [DONE]";

// ── Tests ──

describe("Provider contract — error classification", () => {
  test("ProviderError.retryable is true for transient, false for auth", () => {
    expect(new ProviderError("timeout", "transient").retryable).toBe(true);
    expect(new ProviderError("overloaded", "overload").retryable).toBe(true);
    expect(new ProviderError("bad key", "auth").retryable).toBe(false);
    expect(new ProviderError("bad request", "invalid_request").retryable).toBe(false);
  });

  test("anthropic 400 'prompt is too long' → overflow", async () => {
    const provider = makeProvider(anthropicModel);
    const restore = mockFetch(
      jsonRes({ error: { message: "prompt is too long: 200001 tokens > 200000 maximum" } }, 400),
    );
    const err = await drainAndCaptureError(
      provider.stream(anthropicModel, [{ role: "user", text: "hi" }], { apiKey: "test-key" }),
    );
    restore();
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe("overflow");
  });

  test("anthropic 400 without context keywords → invalid_request", async () => {
    const provider = makeProvider(anthropicModel);
    const restore = mockFetch(jsonRes({ error: { message: "bad request body" } }, 400));
    const err = await drainAndCaptureError(
      provider.stream(anthropicModel, [{ role: "user", text: "hi" }], { apiKey: "test-key" }),
    );
    restore();
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe("invalid_request");
  });

  test("openai 400 'maximum context length' → overflow", async () => {
    const provider = makeProvider(openaiModel);
    const restore = mockFetch(
      jsonRes({ error: { message: "This model's maximum context length is 128000 tokens" } }, 400),
    );
    const err = await drainAndCaptureError(
      provider.stream(openaiModel, [{ role: "user", text: "hi" }], { apiKey: "test-key" }),
    );
    restore();
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe("overflow");
  });
});

describe("Provider contract — credential redaction", () => {
  test("error message redacts apiKey and contains [REDACTED]", async () => {
    const KEY = "sk-ant-secret-sentinel";
    const provider = makeProvider(anthropicModel, KEY);
    const restore = mockFetch(jsonRes({ error: { message: `echo ${KEY} in body` } }, 401));
    const err = await drainAndCaptureError(
      provider.stream(anthropicModel, [{ role: "user", text: "hi" }], { apiKey: KEY }),
    );
    restore();
    expect(err).toBeInstanceOf(ProviderError);
    const pe = err as ProviderError;
    expect(pe.message).not.toContain(KEY);
    expect(pe.message).toContain("[REDACTED]");
    expect(pe.detail).toContain("[REDACTED]");
    // Full serialization must not leak
    expect(JSON.stringify(pe)).not.toContain(KEY);
    // Raw error object must not be retained
    expect(pe).not.toHaveProperty("raw");
  });
});

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

describe("Provider contract — wire serialization", () => {
  test("anthropic serializes tool_result under user role", async () => {
    const provider = makeProvider(anthropicModel);
    const capture = mockFetchCapture(sseRes([DONE]));
    await collectChunks(
      provider.stream(
        anthropicModel,
        [
          { role: "user", text: "hi" },
          {
            role: "assistant",
            text: "",
            blocks: [{ type: "tool_use", id: "t1", name: "read", input: {} }],
          },
          {
            role: "tool",
            text: "ok",
            blocks: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
          },
        ],
        { apiKey: "test-key" },
      ),
    );
    capture.restore();

    const body = capture.getBody();
    expect(body).toBeTruthy();
    const msgs = body!.messages as Array<{ role: string; content: unknown }>;
    const toolMsg = msgs[msgs.length - 1]!;
    expect(toolMsg.role).toBe("user");
    expect(toolMsg.content).toEqual([{ type: "tool_result", tool_use_id: "t1", content: "ok" }]);
  });

  test("openai-completions serializes image blocks as image_url parts", async () => {
    const provider = makeProvider(openaiModel);
    const capture = mockFetchCapture(sseRes([DONE]));
    await collectChunks(
      provider.stream(
        openaiModel,
        [
          {
            role: "user",
            text: "",
            blocks: [
              { type: "text", text: "look" },
              { type: "image", mediaType: "image/png", base64: "aGk=" },
            ],
          },
        ],
        { apiKey: "test-key" },
      ),
    );
    capture.restore();

    const body = capture.getBody();
    const msgs = body!.messages as Array<{ role: string; content: unknown }>;
    expect(msgs[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } },
      ],
    });
  });

  test("openai-completions tool_result carries images as content parts", async () => {
    const provider = makeProvider(openaiModel);
    const capture = mockFetchCapture(sseRes([DONE]));
    await collectChunks(
      provider.stream(
        openaiModel,
        [
          {
            role: "assistant",
            text: "",
            blocks: [{ type: "tool_use", id: "t1", name: "read_image", input: {} }],
          },
          {
            role: "tool",
            text: "",
            blocks: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                content: "[image attached]",
                images: [{ type: "image", mediaType: "image/jpeg", base64: "am9o" }],
              },
            ],
          },
        ],
        { apiKey: "test-key" },
      ),
    );
    capture.restore();

    const body = capture.getBody();
    const msgs = body!.messages as Array<{ role: string; content: unknown }>;
    const toolMsg = msgs[msgs.length - 1]!;
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.content).toEqual([
      { type: "text", text: "[image attached]" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,am9o" } },
    ]);
  });

  test("openai-responses serializes user images as input_image", async () => {
    const responsesModel: Model = { ...openaiModel, api: "openai-responses" };
    const provider = makeProvider(responsesModel);
    const capture = mockFetchCapture(sseRes([DONE]));
    await collectChunks(
      provider.stream(
        responsesModel,
        [
          {
            role: "user",
            text: "",
            blocks: [
              { type: "text", text: "look" },
              { type: "image", mediaType: "image/png", base64: "aGk=" },
            ],
          },
        ],
        { apiKey: "test-key" },
      ),
    );
    capture.restore();

    const body = capture.getBody();
    const input = body!.input as Array<{ type: string; content: unknown }>;
    expect(input[0]).toEqual({
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "look" },
        { type: "input_image", image_url: "data:image/png;base64,aGk=" },
      ],
    });
  });

  test("anthropic serializes tool schemas, defaults missing inputSchema to {}", async () => {
    const provider = makeProvider(anthropicModel);
    const capture = mockFetchCapture(sseRes([DONE]));
    await collectChunks(
      provider.stream(anthropicModel, [{ role: "user", text: "list files" }], {
        apiKey: "test-key",
        tools: [
          { name: "ls", description: "List a directory", inputSchema: { type: "object" } },
          { name: "read", description: "Read a file" },
        ],
      }),
    );
    capture.restore();

    const body = capture.getBody();
    const tools = body!.tools as Array<{
      name: string;
      description: string;
      input_schema: unknown;
    }>;
    expect(tools).toContainEqual({
      name: "ls",
      description: "List a directory",
      input_schema: { type: "object" },
    });
    // Missing inputSchema defaults to {}, tool is not dropped
    expect(tools).toContainEqual({ name: "read", description: "Read a file", input_schema: {} });
  });
});
