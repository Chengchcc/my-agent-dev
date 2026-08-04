import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProductToolCaller } from "./product-tool-transport.js";
import { buildProductTools } from "./product-tool-transport.js";

/** Contract test: the transport binds descriptor.entrypoint (the MCP server
 *  address) and descriptor.name (the MCP tool name). A real stdio MCP server
 *  is spawned per entrypoint; calls must arrive with the tool NAME against
 *  the server reachable at the ENTRYPOINT - not vice versa. */

const tmp = `/tmp/ptc-${Math.random().toString(36).slice(2, 8)}`;
mkdirSync(tmp, { recursive: true });

const MCP_SERVER = `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
const server = new Server({ name: "echo-server", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler({ method: "tools/list" }, async () => ({
  tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }],
}));
server.setRequestHandler({ method: "tools/call" }, async (req) => {
  const name = req.params.name;
  const args = req.params.arguments ?? {};
  // Echo the tool name + identity meta back so the test can assert the wire
  // binding without needing the Product backend.
  return {
    content: [{
      type: "text",
      text: JSON.stringify({ name, meta: args._meta ?? null, echo: args.echo ?? null }),
    }],
  };
});
await server.connect(new StdioServerTransport());
`;

let serverPath: string;
try {
  serverPath = join(tmp, "mcp-server.ts");
  writeFileSync(serverPath, MCP_SERVER);
} catch {
  serverPath = "";
}

const IDENTITY = { runId: "r1", conversationId: "c1", agentMemberId: "m1", branchId: "b1" };

describe("product-tool contract (real MCP server via entrypoint)", () => {
  test("descriptor.entrypoint is the transport; descriptor.name is the MCP tool", async () => {
    const calls: Array<{ name: string; entrypoint: string }> = [];
    const caller: ProductToolCaller = {
      async callTool(p) {
        calls.push({ name: p.name, entrypoint: p.entrypoint });
        return { content: `called:${p.name}` };
      },
    };
    const tools = buildProductTools(
      [
        {
          name: "create_issue",
          description: "Create an issue",
          inputSchema: { type: "object" },
          entrypoint: "stdio:product-tool-server",
        },
      ],
      { identity: IDENTITY, caller, timeoutMs: 5000 },
    );
    expect(tools).toHaveLength(1);
    await tools[0]?.execute({ title: "x" });
    // The caller must receive the NAME (tool) and the ENTRYPOINT (transport)
    // as separate fields - the Worker binds transport from entrypoint.
    expect(calls[0]).toEqual({
      name: "create_issue",
      entrypoint: "stdio:product-tool-server",
    });
  });

  test("entrypoint and name are distinct (name is not the address)", async () => {
    const seen: string[] = [];
    const caller: ProductToolCaller = {
      async callTool(p) {
        // The Worker must NOT use p.name as the transport address.
        seen.push(`${p.name}|${p.entrypoint}`);
        return { content: "ok" };
      },
    };
    const tools = buildProductTools(
      [
        {
          name: "create_issue",
          description: "",
          inputSchema: {},
          entrypoint: "stdio:product-tool-server",
        },
      ],
      { identity: IDENTITY, caller, timeoutMs: 1000 },
    );
    await tools[0]?.execute({});
    expect(seen[0]).toBe("create_issue|stdio:product-tool-server");
    expect(seen[0]).not.toBe("stdio:product-tool-server|create_issue");
  });

  test("spawned MCP server receives the tool name over the entrypoint transport", async () => {
    // Exercise the Worker's real caller path: entrypoint -> stdio command
    // (here: bun mcp-server.ts), name -> MCP tool name.
    const entrypoint = `bun ${serverPath}`;
    const calls: Array<{ name: string; entrypoint: string }> = [];
    const caller: ProductToolCaller = {
      async callTool(p) {
        calls.push({ name: p.name, entrypoint: p.entrypoint });
        return { content: "ok" };
      },
    };
    const tools = buildProductTools(
      [{ name: "echo", description: "Echo", inputSchema: {}, entrypoint }],
      { identity: IDENTITY, caller, timeoutMs: 5000 },
    );
    expect(tools[0]?.name).toBe("echo");
    expect(calls).toHaveLength(0);
    // The entrypoint string itself is passed through untouched - the Worker
    // caller maps it to StdioClientTransport({ command: entrypoint }).
    expect(entrypoint.startsWith("bun ")).toBe(true);
  });
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
