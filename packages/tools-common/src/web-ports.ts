/** Port for web search. Implementations inject search providers. */
export interface WebSearchPort {
  search(
    query: string,
    limit?: number,
  ): Promise<ReadonlyArray<{ title: string; url: string; snippet: string }>>;
}

/** Port for web fetch. Implementations inject HTTP fetch behavior. */
export interface WebFetchPort {
  fetch(url: string): Promise<{ text: string; title?: string }>;
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
    async execute(args: Readonly<Record<string, unknown>>) {
      const results = await port.search(args.query as string, (args.limit as number) ?? 5);
      return { results } as unknown as Readonly<Record<string, unknown>>;
    },
  };
}

/** Create a web_fetch tool backed by the given port. */
export function createWebFetchTool(port: WebFetchPort) {
  return {
    name: "web_fetch",
    description: "Fetch and read the contents of a web page.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "URL to fetch" } },
      required: ["url"],
    } as const,
    async execute(args: Readonly<Record<string, unknown>>) {
      const result = await port.fetch(args.url as string);
      return { text: result.text, title: result.title } as unknown as Readonly<
        Record<string, unknown>
      >;
    },
  };
}
