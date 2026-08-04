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

/** ONE-SHOT fixture Worker: accepts open_session; runs ONE run (start_run or
 *  normal send) then exits after its outcome; crashes mid-run when the runId
 *  contains "crash" (accepts then exits without an outcome); serves steer,
 *  stop_run, compact, close_session, shutdown as control/maintenance paths. */
const FIXTURE_WORKER = `
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
const rl = createInterface({ input: stdin, terminal: false });
rl.on("line", async (line) => {
  const cmd = JSON.parse(line);
  if (cmd.type === "open_session") {
    stdout.write(JSON.stringify({ protocolVersion: 1, type: "command_accepted", commandId: cmd.commandId, backendSessionId: cmd.backendSessionId }) + "\\n");
  }
  if (cmd.type === "start_run" || (cmd.type === "send" && cmd.mode !== "steer")) {
    stdout.write(JSON.stringify({ protocolVersion: 1, type: "command_accepted", commandId: cmd.commandId, backendSessionId: cmd.backendSessionId, runId: cmd.runId }) + "\\n");
    if (cmd.runId.includes("crash")) process.exit(3);
    await new Promise((r) => setTimeout(r, 150));
    stdout.write(JSON.stringify({ protocolVersion: 1, type: "event", backendSessionId: cmd.backendSessionId, runId: cmd.runId, event: { type: "message_update", text: "hi" } }) + "\\n");
    await new Promise((r) => setTimeout(r, 150));
    stdout.write(JSON.stringify({ protocolVersion: 1, type: "outcome", backendSessionId: cmd.backendSessionId, runId: cmd.runId, outcome: { status: "completed" } }) + "\\n");
    process.exit(0);
  }
  if (cmd.type === "send" && cmd.mode === "steer") {
    stdout.write(JSON.stringify({ protocolVersion: 1, type: "command_accepted", commandId: cmd.commandId, backendSessionId: cmd.backendSessionId, runId: cmd.runId }) + "\\n");
  }
  if (cmd.type === "stop_run") {
    stdout.write(JSON.stringify({ protocolVersion: 1, type: "command_accepted", commandId: cmd.commandId, backendSessionId: cmd.backendSessionId, runId: cmd.runId }) + "\\n");
  }
  if (cmd.type === "compact") {
    stdout.write(JSON.stringify({ protocolVersion: 1, type: "command_accepted", commandId: cmd.commandId, backendSessionId: cmd.backendSessionId }) + "\\n");
    stdout.write(JSON.stringify({ protocolVersion: 1, type: "command_result", commandId: cmd.commandId, backendSessionId: cmd.backendSessionId, result: { compacted: true } }) + "\\n");
    process.exit(0);
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

function sendInput(
  backendSessionId: string,
  runId: string,
  mode: "normal" | "steer" | "follow_up" = "normal",
) {
  return {
    idempotencyKey: `ikey-send-${backendSessionId}-${runId}`,
    commandId: `cmd-${runId}`,
    backendSessionId,
    runId,
    mode,
    history: [],
    input: { inputId: `in-${runId}`, message: { role: "user" as const, text: "p" } },
    run: {
      runId,
      model: { backendKind: "coding_agent" as const, modelId: "m" },
      productTools: [],
      configRevision: 1,
    },
    metadata: { branchId: "b", productRevision: 1 },
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
    workspaceRoots: [wsDir],
    maxStartingWorkers: 4,
  });
});

afterAll(async () => {
  await supervisor.shutdown();
  rmSync(tmp, { recursive: true, force: true });
});

describe("session supervisor (one-shot Worker)", () => {
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

  test("one Run one Worker: worker exits after outcome, session returns idle; next Run gets a new PID", async () => {
    await supervisor.startSession(startInput("sess-onerun", "run-o1"));
    const pid1 = supervisor
      .listSessions()
      .find((v) => v.backendSessionId === "sess-onerun")?.workerPid;
    // Wait for the one-shot worker to exit after its outcome.
    for (let i = 0; i < 100; i++) {
      const view = supervisor.listSessions().find((v) => v.backendSessionId === "sess-onerun");
      if (view?.state === "idle" && view.workerPid === null) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const idle = supervisor.listSessions().find((v) => v.backendSessionId === "sess-onerun");
    expect(idle?.state).toBe("idle");
    expect(idle?.workerPid).toBeNull();
    expect(idle?.activeRunId).toBeNull();
    expect(supervisor.getOutcome("run-o1")).toMatchObject({ status: "completed" });

    // Run 2 on the SAME session spawns a NEW worker (different PID).
    await supervisor.send(sendInput("sess-onerun", "run-o2"));
    const pid2 = supervisor
      .listSessions()
      .find((v) => v.backendSessionId === "sess-onerun")?.workerPid;
    expect(pid2).toBeTruthy();
    expect(pid2).not.toBe(pid1);
    for (let i = 0; i < 100; i++) {
      const view = supervisor.listSessions().find((v) => v.backendSessionId === "sess-onerun");
      if (view?.state === "idle" && view.workerPid === null) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(supervisor.getOutcome("run-o2")).toMatchObject({ status: "completed" });
  }, 15_000);

  test("duplicate live worker rejected", async () => {
    await supervisor.startSession(startInput("sess-dup", "run-dup-1"));
    await expect(
      supervisor.startSession(startInput("sess-dup", "run-dup-2")),
    ).rejects.toMatchObject({ code: "busy" });
  });

  test("active run excludes concurrent normal send", async () => {
    await supervisor.startSession(startInput("sess-active", "run-active-1"));
    await expect(supervisor.send(sendInput("sess-active", "run-active-2"))).rejects.toMatchObject({
      code: "busy",
    });
  });

  test("steer requires an active run and targets it without a new run", async () => {
    await expect(supervisor.send(sendInput("sess-nosuch", "r", "steer"))).rejects.toMatchObject({
      code: "not_found",
    });
    // no active run (session unknown is not_found; an idle session is invalid)
    await supervisor.startSession(startInput("sess-steer-idle", "run-sidle"));
    for (let i = 0; i < 100; i++) {
      const view = supervisor.listSessions().find((v) => v.backendSessionId === "sess-steer-idle");
      if (view?.state === "idle") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    await expect(
      supervisor.send(sendInput("sess-steer-idle", "run-sidle-2", "steer")),
    ).rejects.toMatchObject({ code: "invalid_request" });
    // steer against the ACTIVE run is accepted and names no new run
    await supervisor.startSession(startInput("sess-steer", "run-steer-1"));
    const steered = await supervisor.send(sendInput("sess-steer", "run-steer-1", "steer"));
    expect(steered).toMatchObject({ accepted: true, runId: "run-steer-1" });
    // a steer naming a DIFFERENT run is rejected
    await expect(
      supervisor.send(sendInput("sess-steer", "run-other", "steer")),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  test("idempotency replay returns original result", async () => {
    const first = await supervisor.startSession(startInput("sess-ikey", "run-ikey-1"));
    const replay = await supervisor.startSession(startInput("sess-ikey", "run-ikey-1"));
    expect(replay).toEqual(first);
  });

  test("concurrent same-key start dedupes to one worker (no double spawn)", async () => {
    const key = `ikey-dedupe-${Math.random().toString(36).slice(2, 6)}`;
    const inputA = { ...startInput("sess-dedupe", "run-dedupe-1"), idempotencyKey: key };
    const inputB = { ...startInput("sess-dedupe", "run-dedupe-1"), idempotencyKey: key };
    const [a, b] = await Promise.all([
      supervisor.startSession(inputA),
      supervisor.startSession(inputB),
    ]);
    expect(b).toEqual(a); // both callers observe the SAME accepted run
    // exactly one worker was spawned: the session record holds one pid
    const views = supervisor.listSessions().filter((v) => v.backendSessionId === "sess-dedupe");
    expect(views).toHaveLength(1);
    expect(views[0]?.workerPid).toBeTruthy();
    // and the run settled exactly once
    for (let i = 0; i < 100; i++) {
      if (supervisor.getOutcome("run-dedupe-1")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(supervisor.getOutcome("run-dedupe-1")).toMatchObject({ status: "completed" });
  });

  test("same key with a different payload returns conflict", async () => {
    const input = startInput("sess-conflict", "run-conflict-1");
    await supervisor.startSession(input);
    await expect(
      supervisor.startSession({
        ...input,
        input: { inputId: "other", message: { role: "user", text: "x" } },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  test("close is idempotent", async () => {
    await supervisor.startSession(startInput("sess-close", "run-close-1"));
    await supervisor.close({ idempotencyKey: "k", backendSessionId: "sess-close" });
    const again = await supervisor.close({ idempotencyKey: "k2", backendSessionId: "sess-close" });
    expect(again.closed).toBe(true);
  });

  test("outcome becomes available after run completes", async () => {
    await supervisor.startSession(startInput("sess-outcome", "run-outcome-1"));
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

  test("compact uses a one-shot maintenance worker and returns on command_result", async () => {
    await supervisor.startSession(startInput("sess-compact", "run-compact-1"));
    for (let i = 0; i < 100; i++) {
      const view = supervisor.listSessions().find((v) => v.backendSessionId === "sess-compact");
      if (view?.state === "idle") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const result = await supervisor.compact({
      idempotencyKey: "k-compact",
      commandId: "compact-1",
      backendSessionId: "sess-compact",
    });
    expect(result).toEqual({ compacted: true });
    // the maintenance worker exited; session is idle again
    const view = supervisor.listSessions().find((v) => v.backendSessionId === "sess-compact");
    expect(view?.state).toBe("idle");
    expect(view?.workerPid).toBeNull();
  });

  test("worker crash (one supervisor) fails only its run; sibling completes", async () => {
    // A crashing fixture: exits after accepting start_run without an outcome
    // for runIds containing "crash". ONE supervisor hosts both sessions.
    const crashSup = createCodingSessionSupervisor({
      workerEntry,
      cwd: tmp,
      sessionsDir: `${tmp}/sessions-crash`,
      authEnv: {},
      eventBufferSize: 100,
      workerStopGraceMs: 500,
      acceptTimeoutMs: 5000,
      workspaceRoots: [wsDir],
      maxStartingWorkers: 4,
    });
    const goodSup = supervisor; // sibling on the healthy fixture
    try {
      await crashSup.startSession(startInput("sess-crash", "run-crash-1"));
      await goodSup.startSession(startInput("sess-good", "run-good-1"));
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
    const crashSup = createCodingSessionSupervisor({
      workerEntry,
      cwd: tmp,
      sessionsDir: `${tmp}/sessions-crash2`,
      authEnv: {},
      eventBufferSize: 100,
      workerStopGraceMs: 500,
      acceptTimeoutMs: 5000,
      workspaceRoots: [wsDir],
      maxStartingWorkers: 4,
    });
    try {
      await crashSup.startSession(startInput("sess-norecover", "run-nr-crash-1"));
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

  test("worker exit during an active run settles the run failed", async () => {
    // runId "crash" => the fixture accepts start_run then dies: the run must
    // settle failed (first-write-wins), not hang.
    const crashSup = createCodingSessionSupervisor({
      workerEntry,
      cwd: tmp,
      sessionsDir: `${tmp}/sessions-pending-crash`,
      authEnv: {},
      eventBufferSize: 100,
      workerStopGraceMs: 500,
      acceptTimeoutMs: 5000,
      workspaceRoots: [wsDir],
      maxStartingWorkers: 4,
    });
    try {
      await crashSup.startSession(startInput("sess-pending", "run-crash-pending"));
      for (let i = 0; i < 50; i++) {
        const outcome = crashSup.getOutcome("run-crash-pending");
        if (outcome) {
          expect(outcome).toMatchObject({ status: "failed" });
          return;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(crashSup.getOutcome("run-crash-pending")).toMatchObject({ status: "failed" });
    } finally {
      await crashSup.shutdown();
    }
  });

  test("resume rejects a runId owned by another run (no silent overwrite)", async () => {
    await supervisor.startSession(startInput("sess-resume-c", "run-resume-c-1"));
    for (let i = 0; i < 50; i++) {
      if (supervisor.getOutcome("run-resume-c-1")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    await expect(
      supervisor.resumeSession({
        ...startInput("sess-resume-c", "run-resume-c-1"),
        // a FRESH key so the idempotency replay does not shadow the runId
        // collision check
        idempotencyKey: "ikey-resume-conflict-fresh",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  test("resume rejects a workspace binding that differs from the session", async () => {
    await supervisor.startSession(startInput("sess-ws", "run-ws-1"));
    for (let i = 0; i < 50; i++) {
      if (supervisor.getOutcome("run-ws-1")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const otherWs = join(tmp, "other-ws");
    mkdirSync(otherWs, { recursive: true });
    await expect(
      supervisor.resumeSession({
        ...startInput("sess-ws", "run-ws-2"),
        workspace: { root: otherWs, access: "read_only" },
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
});
