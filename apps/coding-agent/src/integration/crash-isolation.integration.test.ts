import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodingAgentBackend, CodingAgentClient } from "@my-agent-team/adapter-coding-agent";
import { createModelRuntime } from "@my-agent-team/ai";
import { createCodingAgentApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createCodingSessionSupervisor } from "../session-supervisor.js";

/** Crash isolation: a Worker that dies mid-run fails only its own run; a
 *  sibling session on a DIFFERENT session (healthy worker) is unaffected.
 *  Two independent daemons share the test process - one running the crashing
 *  worker, one the real worker - proving the crash is contained per-session. */

const tmp = `/tmp/coding-crash-${Math.random().toString(36).slice(2, 8)}`;
const ws = `${tmp}/ws`;
const crashWorker = join(tmp, "crash-worker.ts");
let crashApp: ReturnType<typeof createCodingAgentApp>;
let crashBase: string;
let crashServer: ReturnType<typeof Bun.serve> | null = null;
let goodBase: string;
let goodServer: ReturnType<typeof Bun.serve> | null = null;

function buildConfig(): ReturnType<typeof loadConfig> {
  return loadConfig({
    CODING_AGENT_AUTH_TOKEN: "token-123",
    CODING_AGENT_DATA_DIR: tmp,
    CODING_AGENT_WORKSPACE_ROOTS: ws,
    CODING_AGENT_FAKE_PROVIDER: "1",
  });
}

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
  const config = buildConfig();
  // Daemon A: crashing worker.
  // ONE ModelRuntime per daemon, shared by the app (which registers the fake
  // provider) and the supervisor's preflight model validation.
  const crashRuntime = createModelRuntime();
  const crashSup = createCodingSessionSupervisor({
    workerEntry: crashWorker,
    cwd: tmp,
    sessionsDir: `${tmp}/sessions-crash`,
    authEnv: { ...config.providerEnv, CODING_AGENT_FAKE_PROVIDER: "1" },
    eventBufferSize: 100,
    workerStopGraceMs: 500,
    acceptTimeoutMs: 10_000,
    idleTimeoutMs: 60_000,
    workspaceRoots: config.workspaceRoots,
    maxStartingWorkers: 4,
    modelRuntime: crashRuntime,
  });
  crashApp = createCodingAgentApp({ config, modelRuntime: crashRuntime, supervisor: crashSup });
  crashServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: crashApp.fetch,
  });
  crashBase = `http://127.0.0.1:${crashServer.port}`;

  // Daemon B: real worker (fake provider), sibling must COMPLETE.
  const goodRuntime = createModelRuntime();
  const goodSup = createCodingSessionSupervisor({
    workerEntry: join(import.meta.dir, "..", "worker-main.ts"),
    cwd: tmp,
    sessionsDir: `${tmp}/sessions-good`,
    authEnv: { ...config.providerEnv, CODING_AGENT_FAKE_PROVIDER: "1" },
    eventBufferSize: 100,
    workerStopGraceMs: 500,
    acceptTimeoutMs: 10_000,
    idleTimeoutMs: 60_000,
    workspaceRoots: config.workspaceRoots,
    maxStartingWorkers: 4,
    modelRuntime: goodRuntime,
  });
  const goodApp = createCodingAgentApp({ config, modelRuntime: goodRuntime, supervisor: goodSup });
  goodServer = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: goodApp.fetch });
  goodBase = `http://127.0.0.1:${goodServer.port}`;
});

afterAll(async () => {
  crashServer?.stop();
  goodServer?.stop();
  await crashApp.stop();
  rmSync(tmp, { recursive: true, force: true });
});

describe("crash isolation (real worker)", () => {
  test("crashed run settles failed; sibling on the real worker completes", async () => {
    const crashClient = new CodingAgentClient({ baseUrl: crashBase, authToken: "token-123" });
    const crashBackend = new CodingAgentBackend(crashClient);
    const crashing = await crashBackend.start({
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

    // Sibling on the REAL worker completes with a canonical outcome - the
    // crash on daemon A does not affect daemon B.
    const goodClient = new CodingAgentClient({ baseUrl: goodBase, authToken: "token-123" });
    const goodBackend = new CodingAgentBackend(goodClient);
    const sibling = await goodBackend.start({
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
    const sibOutcome = await sibling.segment.outcome;
    expect(sibOutcome.status).toBe("completed");
    if (sibOutcome.status === "completed") {
      expect(sibOutcome.output).toBeDefined();
    }
    await goodBackend.close(sibling.session);
  }, 30_000);
});
