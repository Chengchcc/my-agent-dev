import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createModelRuntime } from "@my-agent-team/ai";
import { CodingAgentBackend, CodingAgentClient } from "@my-agent-team/adapter-coding-agent";
import { createCodingAgentApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createCodingSessionSupervisor } from "../session-supervisor.js";

/** Crash isolation INSIDE ONE supervisor (the Phase 3 requirement): the
 *  supervisor runs the crash-proxy fixture for every session; the proxy
 *  forwards to the REAL worker-main and only intercepts sessions whose
 *  workspace root contains "crash" (accepting start_run, then dying before
 *  any outcome). Session A (crash workspace) must settle failed and mark the
 *  session crashed; session B (healthy workspace) must COMPLETE on the same
 *  supervisor with its own real worker. */

const tmp = `/tmp/coding-crash-${Math.random().toString(36).slice(2, 8)}`;
const crashWs = `${tmp}/crash-ws`;
const goodWs = `${tmp}/good-ws`;
let baseUrl: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let app: ReturnType<typeof createCodingAgentApp>;

beforeAll(() => {
  mkdirSync(crashWs, { recursive: true });
  mkdirSync(goodWs, { recursive: true });
  const config = loadConfig({
    CODING_AGENT_AUTH_TOKEN: "token-123",
    CODING_AGENT_DATA_DIR: tmp,
    CODING_AGENT_WORKSPACE_ROOTS: `${crashWs}:${goodWs}`,
    CODING_AGENT_FAKE_PROVIDER: "1",
  });
  const runtime = createModelRuntime();
  const supervisor = createCodingSessionSupervisor({
    workerEntry: join(import.meta.dir, "..", "__fixtures__", "crash-proxy.ts"),
    cwd: tmp,
    sessionsDir: `${tmp}/sessions`,
    authEnv: { ...config.providerEnv, CODING_AGENT_FAKE_PROVIDER: "1" },
    eventBufferSize: 100,
    workerStopGraceMs: 1000,
    acceptTimeoutMs: 10_000,
    workspaceRoots: config.workspaceRoots,
    maxStartingWorkers: 4,
    modelRuntime: runtime,
  });
  app = createCodingAgentApp({ config, modelRuntime: runtime, supervisor });
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: app.fetch });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  server?.stop();
  await app.stop();
  rmSync(tmp, { recursive: true, force: true });
});

describe("crash isolation (one supervisor, real workers)", () => {
  test("crash fails only its run; sibling session on the same supervisor completes", async () => {
    const client = new CodingAgentClient({ baseUrl, authToken: "token-123" });
    const backend = new CodingAgentBackend(client);

    // Session A: crashing workspace. The proxy accepts start_run then dies -
    // the run must settle FAILED (not hang), and the session must be crashed.
    const crashing = await backend.start({
      history: [],
      input: { inputId: "in-crash", message: { role: "user", text: "boom" } },
      run: {
        runId: "run-crash",
        model: { backendKind: "coding_agent", modelId: "fake/echo" },
        productTools: [],
        configRevision: 1,
      },
      workspace: { root: crashWs, access: "read_write" },
      metadata: { conversationId: "c", agentMemberId: "m", branchId: "b", productRevision: 1 },
    });
    const outcome = await crashing.segment.outcome;
    expect(outcome.status).toBe("failed");
    expect(
      app.supervisor
        .listSessions()
        .find((v) => v.backendSessionId === crashing.session.backendSessionId)?.state,
    ).toBe("crashed");

    // Session B: healthy workspace, SAME supervisor, real worker - completes.
    const sibling = await backend.start({
      history: [],
      input: { inputId: "in-sib", message: { role: "user", text: "hi" } },
      run: {
        runId: "run-sibling",
        model: { backendKind: "coding_agent", modelId: "fake/echo" },
        productTools: [],
        configRevision: 1,
      },
      workspace: { root: goodWs, access: "read_write" },
      metadata: { conversationId: "c", agentMemberId: "m", branchId: "b", productRevision: 1 },
    });
    const sibOutcome = await sibling.segment.outcome;
    expect(sibOutcome.status).toBe("completed");
    if (sibOutcome.status === "completed") {
      expect(sibOutcome.output).toBeDefined();
    }
    await backend.close(sibling.session);
  }, 30_000);
});
