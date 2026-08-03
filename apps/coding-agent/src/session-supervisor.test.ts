import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CodingSessionSupervisor,
  createCodingSessionSupervisor,
} from "./session-supervisor.js";

const tmp = `/tmp/coding-supervisor-${Math.random().toString(36).slice(2, 8)}`;
const sessionsDir = join(tmp, "sessions");
const wsDir = join(tmp, "ws");
const workerEntry = join(tmp, "fixture-worker.ts");

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
    // emit one event then complete
    stdout.write(JSON.stringify({ protocolVersion: 1, type: "event", backendSessionId: cmd.backendSessionId, runId: cmd.runId, event: { type: "message_update", text: "hi" } }) + "\\n");
    stdout.write(JSON.stringify({ protocolVersion: 1, type: "outcome", backendSessionId: cmd.backendSessionId, runId: cmd.runId, outcome: { status: "completed" } }) + "\\n");
  }
  if (cmd.type === "send" && cmd.mode !== "steer") {
    stdout.write(JSON.stringify({ protocolVersion: 1, type: "command_accepted", commandId: cmd.commandId, backendSessionId: cmd.backendSessionId, runId: cmd.runId }) + "\\n");
    stdout.write(JSON.stringify({ protocolVersion: 1, type: "outcome", backendSessionId: cmd.backendSessionId, runId: cmd.runId, outcome: { status: "completed" } }) + "\\n");
  }
  if (cmd.type === "send" && cmd.mode === "steer") {
    stdout.write(JSON.stringify({ protocolVersion: 1, type: "command_accepted", commandId: cmd.commandId, backendSessionId: cmd.backendSessionId, runId: cmd.runId }) + "\\n");
  }
  if (cmd.type === "shutdown" || cmd.type === "close_session") {
    stdout.write(JSON.stringify({ protocolVersion: 1, type: "command_accepted", commandId: cmd.commandId, backendSessionId: cmd.backendSessionId }) + "\\n");
    process.exit(0);
  }
});
`;

let supervisor: CodingSessionSupervisor;

function startInput(backendSessionId: string, runId: string) {
  return {
    idempotencyKey: `ikey-${backendSessionId}-${runId}`,
    backendSessionId,
    history: [],
    run: {
      runId,
      model: { backendKind: "coding_agent" as const, modelId: "m" },
      productTools: [],
      configRevision: 1,
    },
    workspace: { root: wsDir, access: "read_write" as const },
    metadata: {
      conversationId: "conv",
      agentMemberId: "mem",
      branchId: "branch",
      productRevision: 1,
    },
  };
}

beforeAll(() => {
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(wsDir, { recursive: true });
  writeFileSync(workerEntry, FIXTURE_WORKER);
  supervisor = createCodingSessionSupervisor({
    workerEntry,
    cwd: tmp,
    sessionsDir,
    authEnv: {},
    eventBufferSize: 100,
    workerStopGraceMs: 500,
    acceptTimeoutMs: 5000,
    idleTimeoutMs: 60_000,
    workspaceRoot: wsDir,
  });
});

afterAll(async () => {
  await supervisor.shutdown();
  rmSync(tmp, { recursive: true, force: true });
});

describe("session supervisor", () => {
  test("two sessions get distinct worker pids", async () => {
    const a = await supervisor.startSession(startInput("sess-a", "run-a"));
    const b = await supervisor.startSession(startInput("sess-b", "run-b"));
    const views = supervisor.listSessions();
    const pidA = views.find((v) => v.backendSessionId === "sess-a")?.workerPid;
    const pidB = views.find((v) => v.backendSessionId === "sess-b")?.workerPid;
    expect(pidA).toBeTruthy();
    expect(pidB).toBeTruthy();
    expect(pidA).not.toBe(pidB);
    void a;
    void b;
  });

  test("duplicate live worker rejected", async () => {
    await supervisor.startSession(startInput("sess-dup", "run-dup-1"));
    await expect(
      supervisor.startSession(startInput("sess-dup", "run-dup-2")),
    ).rejects.toMatchObject({ code: "busy" });
  });

  test("active run excludes concurrent normal send", async () => {
    await supervisor.startSession(startInput("sess-active", "run-active-1"));
    await expect(
      supervisor.send({
        idempotencyKey: "ikey-send-1",
        commandId: "c1",
        backendSessionId: "sess-active",
        runId: "run-active-2",
        mode: "normal",
        messages: [],
        run: {
          runId: "run-active-2",
          model: { backendKind: "coding_agent", modelId: "m" },
          productTools: [],
          configRevision: 1,
        },
        promptText: "p",
        metadata: { branchId: "b", productRevision: 1 },
      }),
    ).rejects.toMatchObject({ code: "busy" });
  });

  test("steer requires active run", async () => {
    await expect(
      supervisor.send({
        idempotencyKey: "ikey-steer",
        commandId: "c",
        backendSessionId: "sess-nosuch",
        runId: "r",
        mode: "steer",
        messages: [],
        run: {
          runId: "r",
          model: { backendKind: "coding_agent", modelId: "m" },
          productTools: [],
          configRevision: 1,
        },
        promptText: "steer me",
        metadata: { branchId: "b", productRevision: 1 },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  test("idempotency replay returns original result", async () => {
    const first = await supervisor.startSession(startInput("sess-ikey", "run-ikey-1"));
    const replay = await supervisor.startSession(startInput("sess-ikey", "run-ikey-1"));
    expect(replay).toEqual(first);
  });

  test("close is idempotent", async () => {
    await supervisor.startSession(startInput("sess-close", "run-close-1"));
    await supervisor.close({ idempotencyKey: "k", backendSessionId: "sess-close" });
    const again = await supervisor.close({ idempotencyKey: "k2", backendSessionId: "sess-close" });
    expect(again.closed).toBe(true);
  });

  test("outcome becomes available after run completes", async () => {
    await supervisor.startSession(startInput("sess-outcome", "run-outcome-1"));
    // Poll briefly for the outcome
    for (let i = 0; i < 50; i++) {
      const outcome = supervisor.getOutcome("run-outcome-1");
      if (outcome) {
        expect(outcome).toMatchObject({ status: "completed" });
        return;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(supervisor.getOutcome("run-outcome-1")).not.toBeNull();
  });

  test("crash fails only the active run; sibling session continues", async () => {
    // A crashing fixture: exits after start_run without emitting an outcome.
    const crashEntry = join(tmp, "crash-worker.ts");
    writeFileSync(
      crashEntry,
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
    const crashSup = createCodingSessionSupervisor({
      workerEntry: crashEntry,
      cwd: tmp,
      sessionsDir: `${tmp}/sessions-crash`,
      authEnv: {},
      eventBufferSize: 100,
      workerStopGraceMs: 500,
      acceptTimeoutMs: 5000,
      idleTimeoutMs: 60_000,
      workspaceRoot: wsDir,
    });
    const goodSup = supervisor; // sibling on the healthy fixture
    try {
      await crashSup.startSession(startInput("sess-crash", "run-crash-1"));
      await goodSup.startSession(startInput("sess-good", "run-good-1"));
      // wait for the crash to be observed
      for (let i = 0; i < 50; i++) {
        const view = crashSup.listSessions().find((v) => v.backendSessionId === "sess-crash");
        if (view?.state === "crashed") break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(crashSup.listSessions().find((v) => v.backendSessionId === "sess-crash")?.state).toBe(
        "crashed",
      );
      expect(crashSup.getOutcome("run-crash-1")).toMatchObject({
        status: "failed",
        error: "worker exited unexpectedly",
      });
      // sibling unaffected
      let goodOutcome = null;
      for (let i = 0; i < 50; i++) {
        goodOutcome = goodSup.getOutcome("run-good-1");
        if (goodOutcome) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(goodOutcome).toMatchObject({ status: "completed" });
    } finally {
      await crashSup.shutdown();
    }
  });

  test("no active-loop recovery after crash: new session must use new identity", async () => {
    const crashEntry = join(tmp, "crash-worker2.ts");
    writeFileSync(
      crashEntry,
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
        `    process.exit(4);`,
        `  }`,
        `});`,
      ].join("\n"),
    );
    const crashSup = createCodingSessionSupervisor({
      workerEntry: crashEntry,
      cwd: tmp,
      sessionsDir: `${tmp}/sessions-crash2`,
      authEnv: {},
      eventBufferSize: 100,
      workerStopGraceMs: 500,
      acceptTimeoutMs: 5000,
      idleTimeoutMs: 60_000,
      workspaceRoot: wsDir,
    });
    try {
      await crashSup.startSession(startInput("sess-norecover", "run-nr-1"));
      for (let i = 0; i < 50; i++) {
        if (crashSup.listSessions().some((v) => v.state === "crashed")) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      await expect(
        crashSup.resumeSession(startInput("sess-norecover", "run-nr-2")),
      ).rejects.toMatchObject({ code: "invalid_request" });
    } finally {
      await crashSup.shutdown();
    }
  });

  test("idle session sleeps (worker closed) and wakes on next command", async () => {
    const sleepSup = createCodingSessionSupervisor({
      workerEntry,
      cwd: tmp,
      sessionsDir: `${tmp}/sessions-sleep`,
      authEnv: {},
      eventBufferSize: 100,
      workerStopGraceMs: 300,
      acceptTimeoutMs: 5000,
      idleTimeoutMs: 150,
      reapIntervalMs: 50,
      workspaceRoot: wsDir,
    });
    try {
      await sleepSup.startSession(startInput("sess-sleep", "run-sleep-1"));
      // wait for the reaper to sleep it
      for (let i = 0; i < 100; i++) {
        const view = sleepSup.listSessions().find((v) => v.backendSessionId === "sess-sleep");
        if (view?.state === "sleeping" && view.workerPid === null) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      const view = sleepSup.listSessions().find((v) => v.backendSessionId === "sess-sleep");
      expect(view?.state).toBe("sleeping");
      expect(view?.workerPid).toBeNull();

      // wake: a follow-up send spawns a new worker over the same session
      await sleepSup.send({
        idempotencyKey: "ikey-sleep-send-1",
        commandId: "wake-cmd",
        backendSessionId: "sess-sleep",
        runId: "run-sleep-2",
        mode: "normal",
        messages: [],
        run: {
          runId: "run-sleep-2",
          model: { backendKind: "coding_agent", modelId: "m" },
          productTools: [],
          configRevision: 1,
        },
        promptText: "wake",
        metadata: { branchId: "b", productRevision: 1 },
      });
      const woke = sleepSup.listSessions().find((v) => v.backendSessionId === "sess-sleep");
      expect(woke?.state).toBe("live");
      expect(woke?.workerPid).not.toBeNull();
    } finally {
      await sleepSup.shutdown();
    }
  });
});
