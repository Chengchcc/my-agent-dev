import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodingAgentBackend, CodingAgentClient } from "@my-agent-team/adapter-coding-agent";
import type { BackendEvent } from "@my-agent-team/agent-backend";
import { createModelRuntime } from "@my-agent-team/ai";
import { createCodingAgentApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { ProductToolCaller } from "./product-tool-transport.js";
import { buildProductTools } from "./product-tool-transport.js";
import { createCodingSessionSupervisor } from "./session-supervisor.js";

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

// ─── Full-stack: real Worker -> production caller -> MCP server ────────

const fullStackTmp = `/tmp/ptc-full-${Math.random().toString(36).slice(2, 8)}`;
const ws = `${fullStackTmp}/ws`;
const wrapper = join(fullStackTmp, "mcp-wrapper.sh");
mkdirSync(ws, { recursive: true });
// Absolute bun path: the Worker's spawn env is a controlled allowlist, so a
// PATH lookup for `bun` inside the wrapper is not guaranteed.
writeFileSync(wrapper, `#!/bin/sh\nexec ${process.execPath} ${serverPath}\n`, { mode: 0o755 });
const entrypoint = `stdio:${wrapper}`;

/** One daemon running the REAL worker (worker-main.ts) with a scripted fake
 *  provider + a real stdio MCP echo server reachable via the wrapper. */
function startDaemon(toolScript: Array<{ name: string; input: Record<string, unknown> }>) {
  const tmp = `${fullStackTmp}-${Math.random().toString(36).slice(2, 6)}`;
  mkdirSync(tmp, { recursive: true });
  const config = loadConfig({
    CODING_AGENT_AUTH_TOKEN: "token-123",
    CODING_AGENT_DATA_DIR: tmp,
    CODING_AGENT_WORKSPACE_ROOTS: ws,
    CODING_AGENT_FAKE_PROVIDER: "1",
    CODING_AGENT_ACCEPT_TIMEOUT_MS: "10000",
  });
  const runtime = createModelRuntime();
  const supervisor = createCodingSessionSupervisor({
    workerEntry: join(import.meta.dir, "worker-main.ts"),
    cwd: tmp,
    sessionsDir: `${tmp}/sessions`,
    authEnv: {
      ...config.providerEnv,
      CODING_AGENT_FAKE_PROVIDER: "1",
      CODING_AGENT_FAKE_TOOL: JSON.stringify(toolScript),
    },
    eventBufferSize: 100,
    workerStopGraceMs: 2000,
    acceptTimeoutMs: 10_000,
    workspaceRoots: [ws],
    maxStartingWorkers: 4,
    modelRuntime: runtime,
  });
  const app = createCodingAgentApp({ config, modelRuntime: runtime, supervisor });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: app.fetch });
  const client = new CodingAgentClient({
    baseUrl: `http://127.0.0.1:${server.port}`,
    authToken: "token-123",
  });
  return { tmp, backend: new CodingAgentBackend(client), app, server };
}

function runInput(runId: string) {
  return {
    history: [],
    input: { inputId: `in-${runId}`, message: { role: "user" as const, text: "go" } },
    run: {
      runId,
      model: { backendKind: "coding_agent" as const, modelId: "fake/echo" },
      productTools: [
        {
          name: "echo",
          description: "Echo",
          inputSchema: { type: "object" },
          entrypoint,
        },
      ],
      configRevision: 1,
    },
    workspace: { root: ws, access: "read_write" as const },
    metadata: { conversationId: "c1", agentMemberId: "m1", branchId: "b1", productRevision: 1 },
  };
}

describe("full-stack product tool acceptance (real Worker -> production caller)", () => {
  test("identity rides in call params._meta; events carry the model tool-use callId", async () => {
    const d = startDaemon([{ name: "echo", input: { echo: "hello" } }]);
    try {
      const started = await d.backend.start(runInput("run-fs-1"));
      const outcomeP = started.segment.outcome;
      const events: BackendEvent<"coding_agent">[] = [];
      for await (const ev of started.segment.events) events.push(ev);
      const startedEvent = events.find((e) => e.type === "product_tool_started");
      const outcome = await outcomeP;
      expect(outcome.status).toBe("completed");
      // The START event carries the MODEL tool-use id (PendingToolCall.id),
      // not a fabricated `call-<eventId>`: consumers can correlate it with
      // the Product Tool request identity.
      expect(startedEvent?.type).toBe("product_tool_started");
      if (startedEvent?.type === "product_tool_started") {
        expect(startedEvent.callId).toMatch(/^toolu-fake-\d+$/);
      }
      // The COMPLETED event carries the real result: the echo server echoed
      // the TOP-LEVEL _meta.identity (production wire shape).
      const completed = events.find((e) => e.type === "product_tool_completed");
      expect(completed?.type).toBe("product_tool_completed");
      if (completed?.type === "product_tool_completed") {
        const body = JSON.parse(String((completed.result as { content?: string })?.content));
        const echoed = JSON.parse((body[0] as { text?: string })?.text ?? "{}") as {
          name: string;
          meta?: { identity?: Record<string, unknown> };
          echo?: string;
        };
        expect(echoed.name).toBe("echo");
        expect(echoed.echo).toBe("hello");
        const identity = echoed.meta?.identity;
        expect(identity?.runId).toBe("run-fs-1");
        expect(identity?.conversationId).toBe("c1");
        expect(identity?.agentMemberId).toBe("m1");
        expect(identity?.branchId).toBe("b1");
        // Idempotency key derives from the model tool-use id (same identity
        // as the started event), stable under same-semantics replays.
        expect(identity?.idempotencyKey).toBe(`run-fs-1:${startedEvent?.callId}`);
      }
      await d.backend.close(started.session);
    } finally {
      d.server.stop();
      await d.app.stop();
      rmSync(d.tmp, { recursive: true, force: true });
    }
  }, 30_000);

  test("a failing MCP call surfaces as isError on product_tool_completed", async () => {
    const d = startDaemon([{ name: "echo", input: { echo: "fail" } }]);
    try {
      const started = await d.backend.start(runInput("run-fs-fail"));
      const events: BackendEvent<"coding_agent">[] = [];
      for await (const ev of started.segment.events) events.push(ev);
      const outcome = await started.segment.outcome;
      expect(outcome.status).toBe("completed");
      const completed = events.find((e) => e.type === "product_tool_completed");
      expect(completed?.type).toBe("product_tool_completed");
      if (completed?.type === "product_tool_completed") {
        expect((completed.result as { isError?: boolean })?.isError).toBe(true);
      }
      await d.backend.close(started.session);
    } finally {
      d.server.stop();
      await d.app.stop();
      rmSync(d.tmp, { recursive: true, force: true });
    }
  }, 30_000);

  test("close during a hung product tool call stops promptly (bounded, no hang)", async () => {
    const d = startDaemon([{ name: "echo", input: { echo: "slow" } }]);
    try {
      const started = await d.backend.start(runInput("run-fs-slow"));
      // Wait until the tool call is in flight (started event observed).
      for await (const ev of started.segment.events) {
        if (ev.type === "product_tool_started") break;
      }
      const closeAt = Date.now();
      await d.backend.close(started.session);
      const closeMs = Date.now() - closeAt;
      // Bounded: stop_run -> aborted outcome -> close_session -> exit must
      // NOT wait for the 30s MCP sleep.
      expect(closeMs).toBeLessThan(10_000);
      const outcome = await started.segment.outcome;
      expect(["aborted", "failed"]).toContain(outcome.status);
    } finally {
      d.server.stop();
      await d.app.stop();
      rmSync(d.tmp, { recursive: true, force: true });
    }
  }, 30_000);
});

afterAll(() => {
  rmSync(fullStackTmp, { recursive: true, force: true });
});
