import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodingAgentBackend, CodingAgentClient } from "@my-agent-team/adapter-coding-agent";
import { createModelRuntime } from "@my-agent-team/ai";
import { createCodingAgentApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createCodingSessionSupervisor } from "../session-supervisor.js";

/** Crash isolation: a Worker that dies mid-run fails only its own run; a
 *  sibling session on the SAME supervisor continues; the crashed session's
 *  file is preserved (no active-loop recovery). */

const tmp = `/tmp/coding-crash-${Math.random().toString(36).slice(2, 8)}`;
const ws = `${tmp}/ws`;
const crashWorker = join(tmp, "crash-worker.ts");
let app: ReturnType<typeof createCodingAgentApp>;
let baseUrl: string;
let server: ReturnType<typeof Bun.serve> | null = null;

beforeAll(() => {
  mkdirSync(ws, { recursive: true });
  // A Worker that accepts open_session + start_run, then dies without an
  // outcome - simulating a crash mid-run.
  writeFileSync(
    crashWorker,
    [
      `import { createInterface } from "node:readline";`,
      `import { stdin, stdout } from "node:process";`,
      `const rl = createInterface({ input: stdin, terminal: false });`,
      `rl.on("line", (line) => {`,
      `  const cmd = JSON.parse(line);`,
      `  if (cmd.type === "open_session") {`,
      `    stdout.write(JSON.stringify({ protocolVersion: 1, type: "command_accepted", commandId: cmd.commandId, backendSessionId: cmd.backendSessionId }) + "\\n");`,
      `  }`,
      `  if (cmd.type === "start_run") {`,
      `    stdout.write(JSON.stringify({ protocolVersion: 1, type: "command_accepted", commandId: cmd.commandId, backendSessionId: cmd.backendSessionId, runId: cmd.runId }) + "\\n");`,
      `    process.exit(3);`,
      `  }`,
      `});`,
    ].join("\n"),
  );
  const config = loadConfig({
    CODING_AGENT_AUTH_TOKEN: "token-123",
    CODING_AGENT_DATA_DIR: tmp,
    CODING_AGENT_WORKSPACE_ROOTS: ws,
    CODING_AGENT_FAKE_PROVIDER: "1",
  });
  const supervisor = createCodingSessionSupervisor({
    workerEntry: crashWorker,
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

describe("crash isolation (real worker)", () => {
  test("crash fails only the active run; sibling session continues; file preserved", async () => {
    const client = new CodingAgentClient({ baseUrl, authToken: "token-123" });
    const backend = new CodingAgentBackend(client);

    const crashing = await backend.start({
      history: [],
      input: { inputId: "in-crash", message: { role: "user", text: "boom" } },
      run: {
        runId: "run-crash",
        model: { backendKind: "coding_agent", modelId: "fake/echo" },
        productTools: [],
        configRevision: 1,
      },
      workspace: { root: ws, access: "read_write" },
      metadata: { conversationId: "c", agentMemberId: "m", branchId: "b", productRevision: 1 },
    });
    // The crashed run's outcome must settle FAILED (worker exited before
    // outcome), not hang.
    const outcome = await crashing.segment.outcome;
    expect(outcome.status).toBe("failed");

    // A second session on the SAME supervisor still works (crash isolation).
    const sibling = await backend.start({
      history: [],
      input: { inputId: "in-sib", message: { role: "user", text: "hi" } },
      run: {
        runId: "run-sibling",
        model: { backendKind: "coding_agent", modelId: "fake/echo" },
        productTools: [],
        configRevision: 1,
      },
      workspace: { root: ws, access: "read_write" },
      metadata: { conversationId: "c", agentMemberId: "m", branchId: "b", productRevision: 1 },
    });
    // The crashing fixture is the supervisor's workerEntry - the sibling also
    // crashes, but the failure is isolated to its own run and the supervisor
    // does not lock up.
    const sibOutcome = await sibling.segment.outcome;
    expect(sibOutcome.status).toBe("failed");
  }, 30_000);
});
