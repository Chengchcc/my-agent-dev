import { describe, expect, test } from "bun:test";
import { normalizeProviderError } from "./types.js";

/** oh-my-pi pattern absorption: quota classification + expanded overflow
 * detection (packages/ai/src/utils/{overflow,retry}.ts). */
describe("normalizeProviderError", () => {
  test("zai 429 code 1308 classifies as non-retryable quota", () => {
    const err = new Error('status 429 {"error":{"code":"1308","message":"usage window exceeded"}}');
    const pe = normalizeProviderError(err);
    expect(pe.kind).toBe("quota");
    expect(pe.retryable).toBe(false);
    expect(pe.statusCode).toBe(429);
  });

  test("insufficient_quota is quota regardless of status text", () => {
    const pe = normalizeProviderError(new Error("status 429 insufficient_quota: plan limit"));
    expect(pe.kind).toBe("quota");
    expect(pe.retryable).toBe(false);
  });

  test("plain 429 rate limit stays retryable overload", () => {
    const pe = normalizeProviderError(new Error("status 429 rate limit exceeded"));
    expect(pe.kind).toBe("overload");
    expect(pe.retryable).toBe(true);
  });

  test("anthropic overflow wording maps to overflow", () => {
    const pe = normalizeProviderError(
      new Error("status 400 prompt is too long: 213462 tokens > 200000 maximum"),
    );
    expect(pe.kind).toBe("overflow");
    expect(pe.retryable).toBe(false);
  });

  test("openai-compatible maximum context length maps to overflow", () => {
    const pe = normalizeProviderError(
      new Error(
        "status 400 Input length (265330) exceeds model's maximum context length (262144).",
      ),
    );
    expect(pe.kind).toBe("overflow");
  });

  test("413 request_too_large maps to overflow", () => {
    expect(normalizeProviderError(new Error("status 413 request_too_large")).kind).toBe("overflow");
  });

  test("bedrock throttling is NOT overflow despite token wording", () => {
    const pe = normalizeProviderError(
      new Error(
        "status 400 ThrottlingException: Too many tokens, please wait before trying again.",
      ),
    );
    expect(pe.kind).not.toBe("overflow");
  });

  test("plain invalid request stays invalid_request", () => {
    expect(normalizeProviderError(new Error("status 400 bad JSON body")).kind).toBe(
      "invalid_request",
    );
  });
});
