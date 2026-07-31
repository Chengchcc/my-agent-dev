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
});
