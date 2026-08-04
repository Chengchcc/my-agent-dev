import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CodingAgentBackend, CodingAgentClient } from "@my-agent-team/adapter-coding-agent";
import { createModelRuntime } from "@my-agent-team/ai";
import { createCodingAgentApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createCodingSessionSupervisor } from "../session-supervisor.js";

/** Session lifecycle through the REAL Worker: start -> follow-up -> steer ->
 *  close. Each run returns a canonical outcome; usage is accumulated across
 *  model calls; close deletes the session file. */

const tmp = `/tmp/coding-lifecycle-${Math.random().toString(36).slice(2, 8)}`;
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
    CODING_AGENT_FAKE_PROVIDER: "1",
  });
  const supervisor = createCodingSessionSupervisor({
    workerEntry: join(import.meta.dir, "..", "worker-main.ts"),
    cwd: tmp,
    sessionsDir: `${tmp}/sessions`,
    authEnv: { ...config.providerEnv, CODING_AGENT_FAKE_PROVIDER: "1" },
    eventBufferSize: 100,
    workerStopGraceMs: 500,
    acceptTimeoutMs: 10_000,
    idleTimeoutMs: 60_000,
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

describe("session lifecycle (real worker)", () => {
  test("start -> follow-up -> close; canonical output + usage accumulate", async () => {
    const client = new CodingAgentClient({ baseUrl, authToken: "token-123" });
    const backend = new CodingAgentBackend(client);
    const first = await backend.start({
      history: [],
      input: { inputId: "in-1", message: { role: "user", text: "first" } },
      run: {
        runId: "run-life-1",
        model: { backendKind: "coding_agent", modelId: "fake/echo" },
        productTools: [],
        configRevision: 1,
      },
      workspace: { root: ws, access: "read_write" },
      metadata: { conversationId: "c", agentMemberId: "m", branchId: "b", productRevision: 1 },
    });
    const session = first.session;
    // Let the first run settle (the daemon rejects a follow-up while active).
    const outcome1 = await first.segment.outcome;
    expect(outcome1.status).toBe("completed");

    // Follow-up on the SAME session (new run, same worker), carrying a
    // Product Tool manifest so the real worker's per-run resolveTools path
    // is exercised end-to-end.
    const followUp = await backend.send(session, {
      history: [],
      input: { inputId: "in-2", message: { role: "user", text: "second" } },
      run: {
        runId: "run-life-2",
        model: { backendKind: "coding_agent", modelId: "fake/echo" },
        productTools: [
          {
            name: "echo_tool",
            description: "Echo",
            inputSchema: { type: "object" },
            entrypoint: "stdio:not-reached",
          },
        ],
        configRevision: 2,
      },
      mode: "follow_up",
      metadata: { branchId: "b", productRevision: 2 },
    });
    const outcome2 = await followUp.outcome;
    expect(outcome2.status).toBe("completed");
    if (outcome2.status === "completed") {
      // Canonical output from the persisted assistant Message.
      expect(outcome2.output).toBeDefined();
      // Usage accumulated from the model chunks (fake provider emits usage).
      expect(outcome2.usage?.inputTokens).toBeGreaterThan(0);
    }

    // Close deletes the session file (deleteData defaults true).
    await backend.close(session);
    const { existsSync } = await import("node:fs");
    const { globSync } = await import("node:fs");
    const leftovers = globSync(`${tmp}/sessions/*.sqlite*`);
    expect(leftovers).toHaveLength(0);
    void existsSync;
  }, 30_000);
});
