import { describe, expect, test } from "bun:test";
import { createWebFetchTool, createWebSearchTool } from "./web-ports.js";

describe("web tools", () => {
  test("web_fetch delegates to injected port for safe URL", async () => {
    let fetched = "";
    const tool = createWebFetchTool({
      async fetch(url) {
        fetched = url;
        return { text: "body", title: "T" };
      },
    });
    const result = (await tool.execute({ url: "https://example.com/page" })) as {
      text: string;
      title: string;
    };
    expect(result.text).toBe("body");
    expect(result.title).toBe("T");
    expect(fetched).toBe("https://example.com/page");
  });

  test("web_fetch rejects private hosts without calling port", async () => {
    let called = false;
    const tool = createWebFetchTool({
      async fetch() {
        called = true;
        return { text: "x" };
      },
    });
    const result = (await tool.execute({ url: "http://169.254.169.254/latest/meta-data" })) as {
      error?: string;
    };
    expect(result.error).toContain("Blocked host");
    expect(called).toBe(false);
  });

  test("web_fetch rejects non-http protocol", async () => {
    const tool = createWebFetchTool({
      async fetch() {
        return { text: "x" };
      },
    });
    const result = (await tool.execute({ url: "file:///etc/passwd" })) as { error?: string };
    expect(result.error).toContain("Blocked protocol");
  });

  test("web_fetch port errors become tool errors with isError", async () => {
    const tool = createWebFetchTool({
      async fetch() {
        throw new Error("network down");
      },
    });
    const result = (await tool.execute({ url: "https://example.com/" })) as {
      error?: string;
      isError?: boolean;
    };
    expect(result.error).toContain("web_fetch failed");
    expect(result.error).toContain("network down");
    expect(result.isError).toBe(true);
  });

  test("web_search delegates to injected port", async () => {
    const tool = createWebSearchTool({
      async search(query, limit) {
        return [{ title: query, url: "https://x", snippet: String(limit) }];
      },
    });
    const result = (await tool.execute({ query: "q", limit: 3 })) as {
      results: Array<{ title: string; snippet: string }>;
    };
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.title).toBe("q");
    expect(result.results[0]?.snippet).toBe("3");
  });

  test("web_search port errors become tool errors", async () => {
    const tool = createWebSearchTool({
      async search() {
        throw new Error("quota");
      },
    });
    const result = (await tool.execute({ query: "q" })) as { error?: string };
    expect(result.error).toContain("web_search failed");
  });
});
