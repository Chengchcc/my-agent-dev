import { describe, expect, test } from "bun:test";
import { passthroughHeaders, stripHopByHop } from "./bff";

describe("stripHopByHop", () => {
  test("removes hop-by-hop headers", () => {
    const h = new Headers({
      "content-type": "application/json",
      "transfer-encoding": "chunked",
      connection: "keep-alive",
    });
    const out = stripHopByHop(h);
    expect(out.get("content-type")).toBe("application/json");
    expect(out.get("transfer-encoding")).toBeNull();
    expect(out.get("connection")).toBeNull();
  });

  test("removes all standard hop-by-hop headers", () => {
    const h = new Headers({
      "keep-alive": "timeout=5",
      "proxy-authenticate": "Basic",
      "proxy-authorization": "Bearer x",
      te: "trailers",
      trailers: "x-custom",
      "transfer-encoding": "gzip",
      upgrade: "websocket",
    });
    const out = stripHopByHop(h);
    for (const [k] of h) {
      expect(out.get(k)).toBeNull();
    }
  });
});

describe("passthroughHeaders", () => {
  test("passes through allowed response headers", () => {
    const h = new Headers({
      "content-type": "application/json",
      "content-length": "100",
      "content-encoding": "gzip",
      "cache-control": "no-cache",
    });
    const out = passthroughHeaders(h);
    expect(out.get("content-type")).toBe("application/json");
    expect(out.get("cache-control")).toBe("no-cache");
    // undici transparently decodes the body; originals would mismatch.
    expect(out.get("content-length")).toBeNull();
    expect(out.get("content-encoding")).toBeNull();
  });

  test("filters out non-allowlisted response headers", () => {
    const h = new Headers({
      "content-type": "text/html",
      "x-custom": "secret",
      "set-cookie": "session=abc",
      "x-powered-by": "Express",
    });
    const out = passthroughHeaders(h);
    expect(out.get("content-type")).toBe("text/html");
    expect(out.get("x-custom")).toBeNull();
    expect(out.get("set-cookie")).toBeNull();
  });
});
