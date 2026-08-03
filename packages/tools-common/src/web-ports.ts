import { assertSafeUrl } from "./url-guard.js";

/** Port for web search. Implementations inject search providers. */
export interface WebSearchPort {
  search(
    query: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<{ title: string; url: string; snippet: string }>>;
}

/** Port for web fetch. Implementations inject HTTP fetch behavior and own
 *  redirect validation, response limits, and timeouts. */
export interface WebFetchPort {
  fetch(url: string, signal?: AbortSignal): Promise<{ text: string; title?: string }>;
}

/** Create a web_search tool backed by the given port. */
export function createWebSearchTool(port: WebSearchPort) {
  return {
    name: "web_search",
    description: "Search the web for information.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results", default: 5 },
      },
      required: ["query"],
    } as const,
    async execute(args: Readonly<Record<string, unknown>>, signal?: AbortSignal) {
      try {
        const results = await port.search(
          args.query as string,
          (args.limit as number) ?? 5,
          signal,
        );
        return { results } as unknown as Readonly<Record<string, unknown>>;
      } catch (err) {
        return {
          error: `web_search failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        } as unknown as Readonly<Record<string, unknown>>;
      }
    },
  };
}

/** Create a web_fetch tool backed by the given port. URL safety (protocol,
 *  private-host) is enforced here; redirects/limits/timeouts belong to the
 *  injected port implementation. */
export function createWebFetchTool(port: WebFetchPort) {
  return {
    name: "web_fetch",
    description: "Fetch and read the contents of a web page.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "URL to fetch" } },
      required: ["url"],
    } as const,
    async execute(args: Readonly<Record<string, unknown>>, signal?: AbortSignal) {
      const rawUrl = args.url as string;
      try {
        assertSafeUrl(rawUrl);
        const result = await port.fetch(rawUrl, signal);
        return { text: result.text, title: result.title } as unknown as Readonly<
          Record<string, unknown>
        >;
      } catch (err) {
        if (err instanceof Error && err.name === "UrlGuardError") {
          return {
            error: err.message,
            isError: true,
          } as unknown as Readonly<Record<string, unknown>>;
        }
        return {
          error: `web_fetch failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        } as unknown as Readonly<Record<string, unknown>>;
      }
    },
  };
}
