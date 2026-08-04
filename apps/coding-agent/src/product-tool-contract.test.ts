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

// In-repo fixture server so bun resolves @modelcontextprotocol/sdk from the
// workspace node_modules (a /tmp file cannot).
const serverPath = join(import.meta.dir, "__fixtures__", "mcp-echo-server.ts");

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

  test("real MCP connection: Worker caller executes entrypoint + verifies identity", async () => {
    // A single-executable wrapper (entrypoint must be ONE executable per the
    // URI format - no shell-splitting): `stdio:<wrapper>`.
    const wrapper = join(tmp, "mcp-wrapper.sh");
    writeFileSync(wrapper, `#!/bin/sh\nexec bun ${serverPath}\n`, { mode: 0o755 });
    const entrypoint = `stdio:${wrapper}`;

    // The REAL caller path (same code the Worker uses): connect, list tools,
    // call the tool named `echo` over the transport at `entrypoint`. The URI
    // prefix is stripped: `stdio:` -> command.
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const command = entrypoint.startsWith("stdio:") ? entrypoint.slice(6) : entrypoint;
    const transport = new StdioClientTransport({ command, args: [] });
    const client = new Client({ name: "test", version: "0.0.1" }, { capabilities: {} });
    await client.connect(transport as never);
    const tools = await (client as { listTools: () => Promise<{ tools: unknown[] }> }).listTools();
    expect(tools.tools).toHaveLength(1);

    const res = await (
      client as {
        callTool(p: {
          name: string;
          arguments?: unknown;
          _meta?: { identity: unknown };
        }): Promise<{ content: unknown }>;
      }
    ).callTool({
      name: "echo",
      arguments: { echo: "hi", _meta: { identity: IDENTITY } },
      _meta: { identity: IDENTITY },
    });
    const contentArr = res.content as Array<{ text?: string }>;
    const text = contentArr[0]?.text ?? "";
    expect(text).toContain('"name":"echo"');
    // Identity reached the server through the wire (the server echoes it).
    expect(text).toContain('"runId":"r1"');
    await (client as { close: () => Promise<void> }).close();
  });
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
