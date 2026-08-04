import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** Deterministic stdio MCP server for contract tests. Echoes the tool name +
 *  the `_meta.identity` it received, so a test can assert the wire binding of
 *  descriptor.name and identity propagation without a Product backend. */

const server = new Server(
  { name: "echo-server", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          name,
          meta: args._meta ?? null,
          echo: args.echo ?? null,
        }),
      },
    ],
  };
});

await server.connect(new StdioServerTransport());
