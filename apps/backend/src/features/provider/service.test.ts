import { afterEach, describe, expect, test } from "bun:test";
import type { SettingsService } from "../settings/index.js";
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

const savedOpenAi = process.env.OPENAI_API_KEY;

afterEach(() => {
  if (savedOpenAi === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedOpenAi;
});

describe("ProviderService", () => {
  test("list reflects settings and env credentials", () => {
    const svc = createProviderService(makeSettings());
    expect(svc.list().find((p) => p.id === "groq")?.configured).toBe(false);

    svc.set("anthropic", { apiKey: "sk-ant-test" });
    const anthropic = svc.list().find((p) => p.id === "anthropic");
    expect(anthropic?.configured).toBe(true);

    process.env.OPENAI_API_KEY = "sk-openai-test";
    const openai = svc.list().find((p) => p.id === "openai");
    expect(openai?.configured).toBe(true);
  });

  test("set stores apiKey and exposes it via getProviderEnv", () => {
    const svc = createProviderService(makeSettings());
    svc.set("anthropic", { apiKey: "sk-ant-123", baseUrl: "https://proxy" });
    expect(svc.getProviderEnv()).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-123",
      ANTHROPIC_BASE_URL: "https://proxy",
    });
  });

  test("clear removes settings and resets configured", () => {
    const svc = createProviderService(makeSettings());
    svc.set("groq", { apiKey: "gsk-123" });
    expect(svc.list().find((p) => p.id === "groq")?.configured).toBe(true);
    svc.clear("groq");
    expect(svc.list().find((p) => p.id === "groq")?.configured).toBe(false);
    expect(svc.getProviderEnv()).toEqual({});
  });

  test("unknown provider throws ValidationError", () => {
    const svc = createProviderService(makeSettings());
    expect(() => svc.set("nope", { apiKey: "x" })).toThrow(/Unknown provider/);
    expect(() => svc.clear("nope")).toThrow(/Unknown provider/);
  });

  test("set rejects empty apiKey/baseUrl", () => {
    const svc = createProviderService(makeSettings());
    expect(() => svc.set("openai", { apiKey: "" })).toThrow(/requires an apiKey or baseUrl/);
  });
});
