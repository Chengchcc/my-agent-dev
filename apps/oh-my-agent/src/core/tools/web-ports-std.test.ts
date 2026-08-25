import { afterEach, describe, expect, test } from "bun:test";
import { createDdgWebSearchPort, createStdWebFetchPort } from "./web-ports-std.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(status: number, body: string, headers: Record<string, string> = {}) {
  globalThis.fetch = (async () =>
    new Response(body, { status, headers })) as unknown as typeof fetch;
}

describe("createDdgWebSearchPort", () => {
  test("parses result blocks and unwraps uddg redirect links", async () => {
    mockFetch(
      200,
      `<div class="result results_links">
         <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=abc">Example <b>Docs</b></a>
         <a class="result__snippet">The &amp;best&amp; reference</a>
       </div>
       <div class="result"><a class="result__a" href="https://plain.org/x">Plain</a></div>`,
    );
    const results = await createDdgWebSearchPort().search("example", 5);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: "Example Docs",
      url: "https://example.com/docs",
      snippet: "The &best& reference",
    });
    expect(results[1]?.url).toBe("https://plain.org/x");
  });

  test("bot-challenge page surfaces an error", async () => {
    mockFetch(200, '<html><script src="anomaly.js"></script></html>');
    expect(createDdgWebSearchPort().search("q")).rejects.toThrow(/bot challenge/);
  });
});

describe("createStdWebFetchPort", () => {
  test("extracts title and readable text from HTML", async () => {
    mockFetch(
      200,
      "<html><head><title>Hi &amp; Bye</title><style>x{}</style></head><body><p>Hello</p><script>bad()</script></body></html>",
    );
    const out = await createStdWebFetchPort().fetch("https://example.com/a");
    expect(out.title).toBe("Hi & Bye");
    expect(out.text).toContain("Hello");
    expect(out.text).not.toContain("bad()");
  });

  test("blocks private hosts via the url guard", async () => {
    expect(createStdWebFetchPort().fetch("http://127.0.0.1:3000/")).rejects.toThrow(/Blocked host/);
  });

  test("follows redirects with re-validation", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/start")) {
        return new Response(null, { status: 302, headers: { location: "https://ok.test/final" } });
      }
      return new Response("<title>F</title>final", { status: 200 });
    }) as unknown as typeof fetch;
    const out = await createStdWebFetchPort().fetch("https://example.com/start");
    expect(out.title).toBe("F");
    expect(calls).toHaveLength(2);
  });

  test("redirect to a private host is refused", async () => {
    globalThis.fetch = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://192.168.1.5/admin" },
      })) as unknown as typeof fetch;
    expect(createStdWebFetchPort().fetch("https://example.com/r")).rejects.toThrow(/Blocked host/);
  });
});
