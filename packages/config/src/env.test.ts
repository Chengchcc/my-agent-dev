import { describe, expect, it } from "bun:test";
import { envSchema, parseEnv } from "./env.js";

/** Minimal valid env that satisfies all required fields. */
function baseEnv(): Record<string, string | undefined> {
  return {
    BACKEND_AUTH_TOKEN: "secret-token-123",
  };
}

describe("parseEnv", () => {
  describe("successful parsing with all variables", () => {
    it("parses a fully-populated env object", () => {
      const raw = {
        BACKEND_AUTH_TOKEN: "tok",
        BACKEND_URL: "http://example.com:8080",
        BACKEND_PORT: "4000",
        BACKEND_HOST: "0.0.0.0",
        BACKEND_DATA_DIR: "/data",
        BACKEND_WORKSPACE_ROOT: "/ws",
        BACKEND_TEMPLATE_DIR: "/tpl",
        BACKEND_MAX_CONCURRENT: "16",
        BACKEND_CANCEL_GRACE_MS: "3000",
        ANTHROPIC_API_KEY: "sk-ant-xxx",
        ANTHROPIC_AUTH_TOKEN: "auth-tok",
        ANTHROPIC_BASE_URL: "https://proxy.example.com",
        SESSION_SECRET: "super-secret",
        NODE_ENV: "production",
        MOCK_USER_ID: "user-1",
        MOCK_PASSWORD: "pass",
        RUNNER_ENV: "prod",
      };

      const env = parseEnv(raw);

      expect(env.BACKEND_AUTH_TOKEN).toBe("tok");
      expect(env.BACKEND_URL).toBe("http://example.com:8080");
      expect(env.BACKEND_PORT).toBe(4000);
      expect(env.BACKEND_HOST).toBe("0.0.0.0");
      expect(env.BACKEND_DATA_DIR).toBe("/data");
      expect(env.BACKEND_MAX_CONCURRENT).toBe(16);
      expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-xxx");
      expect(env.NODE_ENV).toBe("production");
      expect(env.RUNNER_ENV).toBe("prod");
    });
  });

  describe("default values for missing optional variables", () => {
    it("applies defaults for fields with .default()", () => {
      const env = parseEnv(baseEnv());

      expect(env.BACKEND_URL).toBe("http://127.0.0.1:3000");
      expect(env.BACKEND_PORT).toBe(3000);
      expect(env.BACKEND_HOST).toBe("127.0.0.1");
      expect(env.BACKEND_MAX_CONCURRENT).toBe(8);
      expect(env.BACKEND_CANCEL_GRACE_MS).toBe(5_000);
    });

    it("returns undefined for missing .optional() fields", () => {
      const env = parseEnv(baseEnv());

      expect(env.BACKEND_DATA_DIR).toBeUndefined();
      expect(env.BACKEND_WORKSPACE_ROOT).toBeUndefined();
      expect(env.BACKEND_TEMPLATE_DIR).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(env.SESSION_SECRET).toBeUndefined();
      expect(env.NODE_ENV).toBeUndefined();
      expect(env.RUNNER_ENV).toBeUndefined();
    });
  });

  describe("missing required variables throw", () => {
    it("throws when BACKEND_AUTH_TOKEN is missing", () => {
      expect(() => parseEnv({})).toThrow(/Invalid environment variables/);
      expect(() => parseEnv({})).toThrow(/BACKEND_AUTH_TOKEN/);
    });

    it("throws when BACKEND_AUTH_TOKEN is empty string", () => {
      expect(() => parseEnv({ BACKEND_AUTH_TOKEN: "" })).toThrow(/BACKEND_AUTH_TOKEN/);
    });

    it("throws when BACKEND_AUTH_TOKEN is undefined", () => {
      expect(() => parseEnv({ BACKEND_AUTH_TOKEN: undefined })).toThrow(/BACKEND_AUTH_TOKEN/);
    });

    it("error message lists the invalid field", () => {
      try {
        parseEnv({});
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
        expect((e as Error).message).toContain("BACKEND_AUTH_TOKEN");
      }
    });
  });

  describe("number coercion", () => {
    it("coerces string BACKEND_PORT to number", () => {
      const env = parseEnv({ ...baseEnv(), BACKEND_PORT: "8080" });
      expect(env.BACKEND_PORT).toBe(8080);
      expect(typeof env.BACKEND_PORT).toBe("number");
    });

    it("coerces string BACKEND_MAX_CONCURRENT to number", () => {
      const env = parseEnv({ ...baseEnv(), BACKEND_MAX_CONCURRENT: "32" });
      expect(env.BACKEND_MAX_CONCURRENT).toBe(32);
      expect(typeof env.BACKEND_MAX_CONCURRENT).toBe("number");
    });

    it("rejects non-numeric port", () => {
      expect(() => parseEnv({ ...baseEnv(), BACKEND_PORT: "abc" })).toThrow();
    });

    it("rejects zero port (must be positive)", () => {
      expect(() => parseEnv({ ...baseEnv(), BACKEND_PORT: "0" })).toThrow();
    });

    it("rejects negative port", () => {
      expect(() => parseEnv({ ...baseEnv(), BACKEND_PORT: "-1" })).toThrow();
    });

    it("rejects float port (must be int)", () => {
      expect(() => parseEnv({ ...baseEnv(), BACKEND_PORT: "3.5" })).toThrow();
    });

    it("rejects zero max concurrent", () => {
      expect(() => parseEnv({ ...baseEnv(), BACKEND_MAX_CONCURRENT: "0" })).toThrow();
    });
  });

  describe("envSchema", () => {
    it("is exported and parseable", () => {
      expect(envSchema).toBeDefined();
      expect(typeof envSchema.safeParse).toBe("function");
    });

    it("safeParse returns success for valid input", () => {
      const result = envSchema.safeParse(baseEnv());
      expect(result.success).toBe(true);
    });

    it("safeParse returns failure for missing required token", () => {
      const result = envSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });
});
