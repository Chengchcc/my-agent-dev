import { describe, expect, test } from "bun:test";
import { sseUrlEndpoint } from "./sse-url.js";

describe("sseUrlEndpoint", () => {
  test("appends /sse to a bare base", () => {
    expect(sseUrlEndpoint("http://127.0.0.1:3005")).toBe("http://127.0.0.1:3005/sse");
  });

  test("keeps an already-suffixed endpoint", () => {
    expect(sseUrlEndpoint("http://127.0.0.1:3005/sse")).toBe("http://127.0.0.1:3005/sse");
  });

  test("keeps a path-suffixed endpoint intact", () => {
    expect(sseUrlEndpoint("https://host/mcp/sse")).toBe("https://host/mcp/sse");
  });
});
