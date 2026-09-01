/** Normalize a base MCP server URL to its SSE endpoint: `<base>/sse`.
 *  The SSEClientTransport GETs the url as-is; the bare base 404s. */
export function sseUrlEndpoint(base: string): string {
  return base.endsWith("/sse") ? base : `${base}/sse`;
}
