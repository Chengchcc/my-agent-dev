import { describe, expect, test } from "bun:test";
import { ProviderError } from "../types.js";
import { anthropicProvider } from "./anthropic.js";
import { createOpenAICompatProvider } from "./openai-compat.js";

describe("Provider contract", () => {
  test("anthropic provider creates ChatModel with stream", async () => {
    const provider = anthropicProvider({ apiKey: "test-key" });
    expect(provider.id).toBe("anthropic");

    const model = provider.createModel(provider.getModels()[0]!, { apiKey: "test-key" });
    expect(model.id).toBeTruthy();
    expect(typeof model.stream).toBe("function");
    // Full stream test requires mock fetch; provider creation is sufficient for contract
  });

  test("openai-compat provider creates ChatModel", () => {
    const models = [
      {
        id: "gpt-4",
        name: "gpt-4",
        provider: "openai",
        api: "openai-completions" as never,
        reasoning: true,
        input: ["text"] as const,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ] as const;

    const provider = createOpenAICompatProvider({
      id: "openai",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      auth: { apiKey: "test" },
      models,
    });
    expect(provider.id).toBe("openai");
    expect(provider.getModels()).toHaveLength(1);
  });

  test("ProviderError has correct retryable flag", () => {
    const t = new ProviderError("timeout", "transient");
    expect(t.retryable).toBe(true);
    const a = new ProviderError("unauthorized", "auth");
    expect(a.retryable).toBe(false);
  });

  test("anthropic 400 with context-length body classifies as overflow", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: { message: "prompt is too long: 200001 tokens > 200000 maximum" },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;
    try {
      const provider = anthropicProvider({ apiKey: "test-key" });
      const model = provider.createModel(provider.getModels()[0]!, { apiKey: "test-key" });
      await expect(
        (async () => {
          for await (const _ of model.stream([{ role: "user", text: "hi" }])) {
            /* drain */
          }
        })(),
      ).rejects.toMatchObject({ kind: "overflow" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("anthropic 400 without context keywords classifies as invalid_request", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "bad request body" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    try {
      const provider = anthropicProvider({ apiKey: "test-key" });
      const model = provider.createModel(provider.getModels()[0]!, { apiKey: "test-key" });
      await expect(
        (async () => {
          for await (const _ of model.stream([{ role: "user", text: "hi" }])) {
            /* drain */
          }
        })(),
      ).rejects.toMatchObject({ kind: "invalid_request" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("openai-compat 400 with token-limit body classifies as overflow", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: { message: "This model's maximum context length is 128000 tokens" },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;
    try {
      const models = [
        {
          id: "gpt-4",
          name: "gpt-4",
          provider: "openai",
          api: "openai-completions" as never,
          reasoning: true,
          input: ["text"] as const,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 4096,
        },
      ] as const;
      const provider = createOpenAICompatProvider({
        id: "openai",
        name: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        auth: { apiKey: "test" },
        models,
      });
      const model = provider.createModel(models[0]!, { apiKey: "test" });
      await expect(
        (async () => {
          for await (const _ of model.stream([{ role: "user", text: "hi" }])) {
            /* drain */
          }
        })(),
      ).rejects.toMatchObject({ kind: "overflow" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
