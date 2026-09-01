import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import type { SettingsService } from "../settings/index.js";
import { providerRoutes } from "./http.js";
import { createProviderService } from "./service.js";

function makeSettings(): SettingsService {
  const map = new Map<string, string>();
  return {
    get<T>(key: string): T | undefined {
      const raw = map.get(key);
      return raw ? (JSON.parse(raw) as T) : undefined;
    },
    set<T>(key: string, value: T): void {
      map.set(key, JSON.stringify(value));
    },
    getAll: () => ({}),
    getSystemInfo: () => ({ env: {}, paths: {} }),
  };
}

describe("providerRoutes", () => {
  test("GET lists providers", async () => {
    const app = new Elysia().use(providerRoutes(createProviderService(makeSettings())));
    const res = await app.handle(new Request("http://test/api/providers"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      providers: Array<{ id: string; name: string; apiKeyEnv: string; configured: boolean }>;
    };
    expect(body.providers.find((p) => p.id === "groq")).toEqual({
      id: "groq",
      name: "Groq",
      apiKeyEnv: "GROQ_API_KEY",
      configured: false,
    });
  });

  test("PUT sets provider and calls onChange", async () => {
    let changed = 0;
    const app = new Elysia().use(
      providerRoutes(createProviderService(makeSettings()), { onChange: () => changed++ }),
    );
    const res = await app.handle(
      new Request("http://test/api/providers/anthropic", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: "sk-ant-123" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(changed).toBe(1);
    const body = (await res.json()) as { provider: { configured: boolean } };
    expect(body.provider.configured).toBe(true);
  });

  test("DELETE clears provider and calls onChange", async () => {
    const svc = createProviderService(makeSettings());
    svc.set("openai", { apiKey: "sk-openai-1" });
    let changed = 0;
    const app = new Elysia().use(providerRoutes(svc, { onChange: () => changed++ }));
    const res = await app.handle(
      new Request("http://test/api/providers/openai", { method: "DELETE" }),
    );
    expect(res.status).toBe(200);
    expect(changed).toBe(1);
    expect(svc.list().find((p) => p.id === "openai")?.configured).toBe(false);
  });

  test("unknown provider returns 422", async () => {
    const app = new Elysia().use(providerRoutes(createProviderService(makeSettings())));
    const res = await app.handle(
      new Request("http://test/api/providers/nope", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: "x" }),
      }),
    );
    expect(res.status).toBe(422);
  });
});
