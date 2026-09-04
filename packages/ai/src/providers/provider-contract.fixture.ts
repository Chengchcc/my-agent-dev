// Side-effect: register all API implementations.
import "./anthropic-messages.js";
import "./openai-completions.js";
import "./openai-responses.js";

import type { AIMessageChunk } from "@chengchenccc/message";
import type { Model } from "../types.js";
import { createProvider } from "./create-provider.js";

// ── Test models ──

export const anthropicModel: Model = {
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

export const openaiModel: Model = {
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

export function makeProvider(model: Model, apiKey = "test-key") {
  return createProvider({
    id: model.provider,
    name: model.provider,
    baseUrl: "https://test.example.com",
    auth: { apiKey },
    models: [model],
  });
}

// ── Fetch mock helpers ──

export function mockFetch(response: Response): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(response)) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

export function mockFetchCapture(response: Response): {
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

export function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function sseRes(lines: string[]): Response {
  return new Response(lines.join("\n"), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

export async function collectChunks(
  stream: AsyncIterable<AIMessageChunk>,
): Promise<AIMessageChunk[]> {
  const out: AIMessageChunk[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

export async function drainAndCaptureError(
  stream: AsyncIterable<AIMessageChunk>,
): Promise<unknown> {
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

export function sseData(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}`;
}

export const DONE = "data: [DONE]";
