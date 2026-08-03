import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { CodingAgentBackend, CodingAgentClient } from "@my-agent-team/adapter-coding-agent";
import { createModelRuntime } from "@my-agent-team/ai";
import { createCodingAgentApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createCodingSessionSupervisor } from "../session-supervisor.js";

const tmp = `/tmp/coding-integration-${Math.random().toString(36).slice(2, 8)}`;
const ws = `${tmp}/ws`;
const workerEntry = `${tmp}/integration-worker.ts`;

const FIXTURE_WORKER = `
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
const rl = createInterface({ input: stdin, terminal: false });
rl.on("line", async (line) => {
  const cmd = JSON.parse(line);
  if (cmd.type === "open_session") {
    stdout.write(JSON.stringify({ protocolVersion: 1, type: "command_accepted", commandId: cmd.commandId, backendSessionId: cmd.backendSessionId }) + "\\n");
  }
  if (cmd.type === "start_run") {
    stdout.write(JSON.stringify({ protocolVersion: 1, type: "command_accepted", commandId: cmd.commandId, backendSessionId: cmd.backendSessionId, runId: cmd.runId }) + "\\n");
    await new Promise((r) => setTimeout(r, 50));
    stdout.write(JSON.stringify({ protocolVersion: 1, type: "event", backendSessionId: cmd.backendSessionId, runId: cmd.runId, event: { type: "message_update", text: "hello" } }) + "\\n");
    await new Promise((r) => setTimeout(r, 50));
    stdout.write(JSON.stringify({ protocolVersion: 1, type: "event", backendSessionId: cmd.backendSessionId, runId: cmd.runId, event: { type: "agent_end", status: "completed" } }) + "\\n");
    await new Promise((r) => setTimeout(r, 50));
    stdout.write(JSON.stringify({ protocolVersion: 1, type: "outcome", backendSessionId: cmd.backendSessionId, runId: cmd.runId, outcome: { status: "completed" } }) + "\\n");
  }
  if (cmd.type === "send" && cmd.mode === "steer") {
    stdout.write(JSON.stringify({ protocolVersion: 1, type: "command_accepted", commandId: cmd.commandId, backendSessionId: cmd.backendSessionId, runId: cmd.runId }) + "\\n");
    stdout.write(JSON.stringify({ protocolVersion: 1, type: "event", backendSessionId: cmd.backendSessionId, runId: cmd.runId, event: { type: "message_update", text: "steered" } }) + "\\n");
  }
  if (cmd.type === "shutdown" || cmd.type === "close_session") {
    stdout.write(JSON.stringify({ protocolVersion: 1, type: "command_accepted", commandId: cmd.commandId, backendSessionId: cmd.backendSessionId }) + "\\n");
    process.exit(0);
  }
});
`;

let app: ReturnType<typeof createCodingAgentApp>;
let baseUrl: string;
let server: ReturnType<typeof Bun.serve> | null = null;

beforeAll(() => {
  mkdirSync(ws, { recursive: true });
  writeFileSync(workerEntry, FIXTURE_WORKER);
  const config = loadConfig({
    CODING_AGENT_AUTH_TOKEN: "token-123",
    CODING_AGENT_DATA_DIR: tmp,
    CODING_AGENT_WORKSPACE_ROOTS: ws,
  });
  const supervisor = createCodingSessionSupervisor({
    workerEntry,
    cwd: tmp,
    sessionsDir: `${tmp}/sessions`,
    authEnv: {},
    eventBufferSize: 100,
    workerStopGraceMs: 500,
    acceptTimeoutMs: 5000,
    idleTimeoutMs: 60_000,
    workspaceRoot: ws,
  });
  app = createCodingAgentApp({ config, modelRuntime: createModelRuntime(), supervisor });
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: app.fetch });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  server?.stop();
  await app.stop();
  rmSync(tmp, { recursive: true, force: true });
});

describe("adapter-to-daemon integration", () => {
  test("start() consumes events and outcome through the real app", async () => {
    const client = new CodingAgentClient({ baseUrl, authToken: "token-123" });
    const backend = new CodingAgentBackend(client);
    const result = await backend.start({
      history: [{ productEntryId: "pe-1", message: { role: "user", text: "hi" } }],
      input: { inputId: "in-1", message: { role: "user", text: "do it" } },
      run: {
        runId: "run-int-1",
        model: { backendKind: "coding_agent", modelId: "m" },
        productTools: [],
        configRevision: 1,
      },
      workspace: { root: ws, access: "read_write" },
      metadata: { conversationId: "c", agentMemberId: "m", branchId: "b", productRevision: 1 },
    });
    expect(result.session.backendKind).toBe("coding_agent");

    // Consume events
    const texts: string[] = [];
    for await (const event of result.segment.events) {
      if (event.type === "text_delta") texts.push(event.text);
      if (event.type === "status") break;
    }
    expect(texts).toContain("hello");

    // Outcome is terminal authority
    const outcome = await result.segment.outcome;
    expect(outcome.status).toBe("completed");

    // Close through the backend
    await backend.close(result.session);
  });

  test("steer routes through send(mode: steer)", async () => {
    const client = new CodingAgentClient({ baseUrl, authToken: "token-123" });
    const backend = new CodingAgentBackend(client);
    const started = await backend.start({
      history: [],
      input: { inputId: "in-2", message: { role: "user", text: "go" } },
      run: {
        runId: "run-int-2",
        model: { backendKind: "coding_agent", modelId: "m" },
        productTools: [],
        configRevision: 1,
      },
      workspace: { root: ws, access: "read_write" },
      metadata: { conversationId: "c", agentMemberId: "m", branchId: "b", productRevision: 1 },
    });
    // Steer is delivered to the active run; send() returns a settled segment.
    const segment = await backend.send(started.session, {
      history: [],
      input: { inputId: "in-3", message: { role: "user", text: "steer me" } },
      run: {
        runId: "run-int-3",
        model: { backendKind: "coding_agent", modelId: "m" },
        productTools: [],
        configRevision: 1,
      },
      mode: "steer",
      metadata: { branchId: "b", productRevision: 1 },
    });
    expect(segment).toBeTruthy();
    await backend.close(started.session);
  });
});
