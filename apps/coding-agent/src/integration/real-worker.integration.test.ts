import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CodingAgentBackend, CodingAgentClient } from "@my-agent-team/adapter-coding-agent";
import { createModelRuntime } from "@my-agent-team/ai";
import { createCodingAgentApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createCodingSessionSupervisor } from "../session-supervisor.js";

/** Real process-level acceptance: Adapter → HTTP/SSE → Supervisor → real
 *  Worker PROCESS → real worker-main → real CodingAgentSession + SessionStore
 *  → fake deterministic Provider. No fixture script substitutes for the
 *  Worker; this exercises the actual Runtime assembly, acceptance handshake,
 *  store create/open, and outcome with a final Message. */

const tmp = `/tmp/coding-real-${Math.random().toString(36).slice(2, 8)}`;
const ws = `${tmp}/ws`;
let app: ReturnType<typeof createCodingAgentApp>;
let baseUrl: string;
let server: ReturnType<typeof Bun.serve> | null = null;

beforeAll(() => {
  mkdirSync(ws, { recursive: true });
  const config = loadConfig({
    CODING_AGENT_AUTH_TOKEN: "token-123",
    CODING_AGENT_DATA_DIR: tmp,
    CODING_AGENT_WORKSPACE_ROOTS: ws,
    // Force the fake deterministic provider into the Worker env.
    CODING_AGENT_FAKE_PROVIDER: "1",
    // Shrink the acceptance window so a stuck Worker fails fast.
    CODING_AGENT_ACCEPT_TIMEOUT_MS: "10000",
  });
  const supervisor = createCodingSessionSupervisor({
    workerEntry: join(import.meta.dir, "..", "worker-main.ts"),
    cwd: tmp,
    sessionsDir: `${tmp}/sessions`,
    authEnv: { ...config.providerEnv, CODING_AGENT_FAKE_PROVIDER: "1" },
    eventBufferSize: 100,
    workerStopGraceMs: 500,
    acceptTimeoutMs: 10_000,
    workspaceRoots: config.workspaceRoots,
    maxStartingWorkers: 4,
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

describe("real worker process integration (fake provider)", () => {
  test("start() runs the real Runtime and resolves a completed outcome with output", async () => {
    const client = new CodingAgentClient({ baseUrl, authToken: "token-123" });
    const backend = new CodingAgentBackend(client);
    const result = await backend.start({
      history: [{ productEntryId: "pe-1", message: { role: "user", text: "hi" } }],
      input: { inputId: "in-1", message: { role: "user", text: "say done" } },
      run: {
        runId: "run-real-1",
        model: { backendKind: "coding_agent", modelId: "fake/echo" },
        productTools: [],
        configRevision: 1,
      },
      workspace: { root: ws, access: "read_write" },
      metadata: { conversationId: "c", agentMemberId: "m", branchId: "b", productRevision: 1 },
    });
    expect(result.session.backendKind).toBe("coding_agent");

    // Consume the event stream until the run settles.
    const types: string[] = [];
    for await (const event of result.segment.events) {
      types.push(event.type);
    }
    // The fake provider streams text; the loop emits message lifecycle events.
    expect(types).toContain("text_delta");

    // Outcome is terminal authority and carries the final assistant Message.
    const outcome = await result.segment.outcome;
    expect(outcome.status).toBe("completed");
    if (outcome.status === "completed") {
      expect(outcome.output).toBeDefined();
    }

    await backend.close(result.session);
  }, 30_000);
});
