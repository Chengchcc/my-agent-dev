import { describe, expect, test } from "bun:test";
import { createModelRuntime } from "@chengchenccc/ai";
import { registerProvidersFromCatalog } from "./runtime-catalog.js";

describe("registerProvidersFromCatalog credentials", () => {
  test("inline apiKey in ProviderSpec registers the provider when env is unset", () => {
    const runtime = createModelRuntime();
    registerProvidersFromCatalog(
      runtime,
      {
        providers: {
          llmbox: {
            api: "openai-completions",
            baseUrl: "https://llmbox.example/v1",
            apiKeyEnv: "LLMBOX_API_KEY",
            apiKey: "at-8331-inline",
            models: [{ id: "m", name: "M" }],
          },
        },
      },
      {}, // no env key
    );

    expect(runtime.getProvider("llmbox")).toBeDefined();
  });

  test("env var still wins over the inline apiKey", () => {
    const runtime = createModelRuntime();
    registerProvidersFromCatalog(
      runtime,
      {
        providers: {
          llmbox: {
            api: "openai-completions",
            baseUrl: "https://llmbox.example/v1",
            apiKeyEnv: "LLMBOX_API_KEY",
            apiKey: "at-8331-inline",
            models: [{ id: "m", name: "M" }],
          },
        },
      },
      { LLMBOX_API_KEY: "at-8331-env" },
    );

    expect(runtime.getProvider("llmbox")).toBeDefined();
  });

  test("provider without any credential is still skipped", () => {
    const runtime = createModelRuntime();
    registerProvidersFromCatalog(
      runtime,
      {
        providers: {
          secretless: {
            api: "openai-completions",
            baseUrl: "https://x.example/v1",
            apiKeyEnv: "NEVER_SET",
            models: [{ id: "m", name: "M" }],
          },
        },
      },
      {},
    );

    expect(runtime.getProvider("secretless")).toBeUndefined();
  });
});
