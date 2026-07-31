import { describe, expect, test } from "bun:test";
import { type Model, ProviderError } from "../types.js";
import { anthropicProvider } from "./anthropic.js";
import { createOpenAICompatProvider } from "./openai-compat.js";

const OPENAI_MODELS: readonly Model[] = [
  {
    id: "gpt-4",
    name: "gpt-4",
    provider: "openai",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  },
];

function drain(stream: AsyncIterable<unknown>): Promise<void> {
  return (async () => {
    for await (const _ of stream) {
      /* drain */
    }
  })();
}

async function withFetch(response: Response, fn: () => Promise<unknown>): Promise<unknown> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => response) as unknown as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("Provider contract", () => {
  test("anthropic provider exposes stream on model", async () => {
    const provider = anthropicProvider({ apiKey: "test-key" });
    expect(provider.id).toBe("anthropic");
    expect(typeof provider.stream).toBe("function");
    expect(provider.getModels().length).toBeGreaterThan(0);
  });

  test("openai-compat provider exposes stream on model", () => {
    const provider = createOpenAICompatProvider({
      id: "openai",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      auth: { apiKey: "test" },
      models: OPENAI_MODELS,
    });
    expect(provider.id).toBe("openai");
    expect(typeof provider.stream).toBe("function");
    expect(provider.getModels()).toHaveLength(1);
  });

  test("ProviderError has correct retryable flag", () => {
    const t = new ProviderError("timeout", "transient");
    expect(t.retryable).toBe(true);
    const a = new ProviderError("unauthorized", "auth");
    expect(a.retryable).toBe(false);
  });

  test("anthropic 400 with context-length body classifies as overflow", async () => {
    const provider = anthropicProvider({ apiKey: "test-key" });
    const model = provider.getModels()[0]!;
    const err = await withFetch(
      new Response(
        JSON.stringify({
          error: { message: "prompt is too long: 200001 tokens > 200000 maximum" },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
      () =>
        drain(provider.stream(model, [{ role: "user", text: "hi" }], { apiKey: "test-key" })).then(
          () => null,
          (e: unknown) => e,
        ),
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe("overflow");
  });

  test("anthropic 400 without context keywords classifies as invalid_request", async () => {
    const provider = anthropicProvider({ apiKey: "test-key" });
    const model = provider.getModels()[0]!;
    const err = await withFetch(
      new Response(JSON.stringify({ error: { message: "bad request body" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
      () =>
        drain(provider.stream(model, [{ role: "user", text: "hi" }], { apiKey: "test-key" })).then(
          () => null,
          (e: unknown) => e,
        ),
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe("invalid_request");
  });

  test("openai-compat 400 with token-limit body classifies as overflow", async () => {
    const provider = createOpenAICompatProvider({
      id: "openai",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      auth: { apiKey: "test" },
      models: OPENAI_MODELS,
    });
    const err = await withFetch(
      new Response(
        JSON.stringify({
          error: { message: "This model's maximum context length is 128000 tokens" },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
      () =>
        drain(
          provider.stream(OPENAI_MODELS[0]!, [{ role: "user", text: "hi" }], {
            apiKey: "test",
          }),
        ).then(
          () => null,
          (e: unknown) => e,
        ),
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe("overflow");
  });

  test("provider errors redact credential material from message", async () => {
    const provider = anthropicProvider({ apiKey: "sk-ant-secret-sentinel" });
    const model = provider.getModels()[0]!;
    const err = await withFetch(
      new Response(JSON.stringify({ error: { message: "echo sk-ant-secret-sentinel in body" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
      () =>
        drain(
          provider.stream(model, [{ role: "user", text: "hi" }], {
            apiKey: "sk-ant-secret-sentinel",
          }),
        ).then(
          () => null,
          (e: unknown) => e,
        ),
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe("auth");
    expect(String((err as ProviderError).message)).not.toContain("sk-ant-secret-sentinel");
    expect(String((err as ProviderError).message)).toContain("[REDACTED]");
    // The raw error object must not be retained anywhere on ProviderError
    const serialized = JSON.stringify(err);
    expect(serialized).not.toContain("sk-ant-secret-sentinel");
    expect(err as ProviderError).not.toHaveProperty("raw");
    // detail carries only the redacted message
    expect((err as ProviderError).detail).toContain("[REDACTED]");
  });

  test("anthropic tool_use stream pairs input_json_delta with tool id", async () => {
    const provider = anthropicProvider({ apiKey: "test-key" });
    const model = provider.getModels()[0]!;
    const sse = [
      `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "read" } })}`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a' } })}`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '.ts"}' } })}`,
      `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
      "data: [DONE]",
    ].join("\n");
    const chunks = await withFetch(
      new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
      async () => {
        const out: unknown[] = [];
        for await (const c of provider.stream(model, [{ role: "user", text: "hi" }], {
          apiKey: "test-key",
        })) {
          out.push(c);
        }
        return out;
      },
    );
    const toolUse = (chunks as Array<{ delta?: { type: string; id?: string } }>).find(
      (c) => c.delta?.type === "tool_use",
    );
    expect(toolUse).toBeTruthy();
    expect((toolUse as { delta: { id: string } }).delta.id).toBe("toolu_1");
  });

  test("openai-compat streams tool arguments as input_json_delta pairs", async () => {
    const provider = createOpenAICompatProvider({
      id: "openai",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      auth: { apiKey: "test" },
      models: OPENAI_MODELS,
    });
    // Standard OpenAI tool-call streaming: first chunk carries id+name,
    // later chunks carry only index + function.arguments fragments.
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "echo", arguments: "" } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"x":' } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}`,
      "data: [DONE]",
    ].join("\n");
    const chunks = await withFetch(
      new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
      async () => {
        const out: unknown[] = [];
        for await (const c of provider.stream(OPENAI_MODELS[0]!, [{ role: "user", text: "hi" }], {
          apiKey: "test",
        })) {
          out.push(c);
        }
        return out;
      },
    );
    const typed = chunks as Array<{
      delta?: { type: string; id?: string; name?: string; partial_json?: string };
    }>;
    const toolUse = typed.find((c) => c.delta?.type === "tool_use");
    expect(toolUse).toBeTruthy();
    expect(toolUse?.delta?.id).toBe("call_1");
    expect(toolUse?.delta?.name).toBe("echo");

    // Argument fragments must pair to the same tool id, not spawn empty tool_use
    const deltas = typed.filter((c) => c.delta?.type === "input_json_delta");
    expect(deltas).toHaveLength(2);
    expect(deltas[0]?.delta?.id).toBe("call_1");
    expect(deltas[1]?.delta?.id).toBe("call_1");
    expect(deltas.map((d) => d.delta?.partial_json).join("")).toBe('{"x":1}');
    // No empty-id tool_use emitted for argument-only chunks
    const emptyToolUses = typed.filter((c) => c.delta?.type === "tool_use" && !c.delta.id);
    expect(emptyToolUses).toHaveLength(0);
  });

  test("openai-compat streams multiple tool calls in one chunk", async () => {
    const provider = createOpenAICompatProvider({
      id: "openai",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      auth: { apiKey: "test" },
      models: OPENAI_MODELS,
    });
    const sse = [
      `data: ${JSON.stringify({
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
      })}`,
      `data: ${JSON.stringify({
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
      })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}`,
      "data: [DONE]",
    ].join("\n");
    const chunks = await withFetch(
      new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
      async () => {
        const out: unknown[] = [];
        for await (const c of provider.stream(OPENAI_MODELS[0]!, [{ role: "user", text: "hi" }], {
          apiKey: "test",
        })) {
          out.push(c);
        }
        return out;
      },
    );
    const typed = chunks as Array<{
      delta?: { type: string; id?: string; name?: string; partial_json?: string };
    }>;
    const toolUses = typed.filter((c) => c.delta?.type === "tool_use");
    expect(toolUses).toHaveLength(2);
    expect(toolUses[0]?.delta?.id).toBe("call_a");
    expect(toolUses[1]?.delta?.id).toBe("call_b");
    const deltas = typed.filter((c) => c.delta?.type === "input_json_delta");
    expect(deltas).toHaveLength(2);
    expect(deltas[0]?.delta?.id).toBe("call_a");
    expect(deltas[1]?.delta?.id).toBe("call_b");
  });

  test("openai-compat survives SSE lines split across network chunks", async () => {
    const provider = createOpenAICompatProvider({
      id: "openai",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      auth: { apiKey: "test" },
      models: OPENAI_MODELS,
    });
    // One data: line torn across two body chunks mid-line.
    const full = `data: ${JSON.stringify({ choices: [{ delta: { content: "hello-world" } }] })}\n\ndata: [DONE]\n`;
    const cut = Math.floor(full.length / 2);
    const part1 = new TextEncoder().encode(full.slice(0, cut));
    const part2 = new TextEncoder().encode(full.slice(cut));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(part1);
        controller.enqueue(part2);
        controller.close();
      },
    });
    const chunks = await withFetch(
      new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
      async () => {
        const out: unknown[] = [];
        for await (const c of provider.stream(OPENAI_MODELS[0]!, [{ role: "user", text: "hi" }], {
          apiKey: "test",
        })) {
          out.push(c);
        }
        return out;
      },
    );
    const texts = (chunks as Array<{ delta?: { type: string; text?: string } }>)
      .filter((c) => c.delta?.type === "text")
      .map((c) => c.delta?.text)
      .join("");
    expect(texts).toBe("hello-world");
  });

  test("anthropic serializes tool_result blocks under a user role message", async () => {
    const provider = anthropicProvider({ apiKey: "test-key" });
    const model = provider.getModels()[0]!;
    let sentBody: Record<string, unknown> | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body));
      return new Response("data: [DONE]\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;
    try {
      await drain(
        provider.stream(
          model,
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
    } finally {
      globalThis.fetch = originalFetch;
    }
    const messages = (sentBody ?? {}) as { messages: Array<{ role: string; content: unknown }> };
    expect(messages.messages).toHaveLength(3);
    const toolResultMsg = messages.messages[2]!;
    expect(toolResultMsg.role).toBe("user");
    expect(toolResultMsg.content).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: "ok" },
    ]);
  });
});
