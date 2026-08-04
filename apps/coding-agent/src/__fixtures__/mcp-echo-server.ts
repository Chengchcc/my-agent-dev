import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** Deterministic stdio MCP server for contract tests. Echoes the tool name +
 *  the TOP-LEVEL `_meta.identity` it received (the production wire shape:
 *  identity rides in call params._meta, never inside arguments), so a test
 *  can assert the wire binding of descriptor.name and identity propagation
 *  without a Product backend.
 *
 *  Modes by `echo` value:
 *    - "fail": the call rejects (server error) - failure path.
 *    - "slow": the call sleeps 30s - lets a test abort/stop mid-call. */

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
  const params = req.params as { _meta?: unknown };
  if (args.echo === "slow") {
    await new Promise((r) => setTimeout(r, 30_000));
  }
  if (args.echo === "fail") {
    throw new Error("echo failed on purpose");
  }
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          name,
          meta: params._meta ?? null,
          echo: args.echo ?? null,
        }),
      },
    ],
  };
});

await server.connect(new StdioServerTransport());
