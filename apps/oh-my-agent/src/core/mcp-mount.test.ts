import { describe, expect, test, vi } from "bun:test";
import { mcpCallTimeoutMs, withCallTimeout } from "./mcp-mount.js";

describe("withCallTimeout", () => {
  test("times out a hanging call with the tool label", async () => {
    vi.useFakeTimers();
    try {
      const p = withCallTimeout(new Promise<never>(() => {}), "mcp tool x", 30);
      vi.advanceTimersByTime(30);
      await expect(p).rejects.toThrow("mcp tool x timed out after 30ms");
    } finally {
      vi.useRealTimers();
    }
  });

  test("passes a resolved call through", async () => {
    expect(await withCallTimeout(Promise.resolve("ok"), "t", 1000)).toBe("ok");
  });

  test("an already-aborted signal rejects immediately", async () => {
    const c = new AbortController();
    c.abort();
    await expect(
      withCallTimeout(new Promise<string>(() => {}), "t", 10_000, c.signal),
    ).rejects.toThrow("Aborted");
  });

  test("timeout 0 with no signal disables the bound entirely", async () => {
    vi.useFakeTimers();
    try {
      const later = new Promise<string>((resolve) => setTimeout(() => resolve("slow"), 50));
      const p = withCallTimeout(later, "t", 0);
      vi.advanceTimersByTime(50);
      expect(await p).toBe("slow");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("mcpCallTimeoutMs", () => {
  test("default 120s, env override, 0 disables, invalid falls back", () => {
    expect(mcpCallTimeoutMs()).toBe(120_000);
    process.env.OMA_MCP_TIMEOUT_MS = "5";
    expect(mcpCallTimeoutMs()).toBe(5);
    process.env.OMA_MCP_TIMEOUT_MS = "0";
    expect(mcpCallTimeoutMs()).toBe(0);
    process.env.OMA_MCP_TIMEOUT_MS = "abc";
    expect(mcpCallTimeoutMs()).toBe(120_000);
    delete process.env.OMA_MCP_TIMEOUT_MS;
  });
});
