import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnWorkerProcess, type WorkerProcessEvents } from "./worker-process.js";
import type { WorkerCommand, WorkerMessage } from "./worker-protocol.js";
import { serializeMessage } from "./worker-protocol.js";

/** Direct unit coverage of the Worker acceptance mechanism: send() resolves on
 *  command_accepted, rejects on exit-before-accept / timeout / identity
 *  mismatch. The supervisor suite exercises this end-to-end via real spawns;
 *  these tests isolate the pending-command + identity logic. */

const tmp = `/tmp/wp-${Math.random().toString(36).slice(2, 8)}`;
mkdirSync(tmp, { recursive: true });
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
});
afterAllCleanup();

// bun:test has no afterAll file hook import here; use process exit cleanup.
function afterAllCleanup() {
  process.on("beforeExit", () => rmSync(tmp, { recursive: true, force: true }));
}

function fixture(name: string, body: string): string {
  const entry = join(tmp, name);
  writeFileSync(
    entry,
    `import { createInterface } from "node:readline";\nimport { stdin, stdout } from "node:process";\nconst rl = createInterface({ input: stdin, terminal: false });\nrl.on("line", (line) => {\n${body}\n});\n`,
  );
  return entry;
}

function noopEvents(): WorkerProcessEvents {
  return {
    onMessage() {},
    onExit() {},
    onMalformedOutput() {},
  };
}

const openCmd = (backendSessionId: string): WorkerCommand => ({
  protocolVersion: 1,
  type: "open_session",
  commandId: `open-${backendSessionId}`,
  backendSessionId,
  dataDir: tmp,
  workspaceRoot: tmp,
  backendKind: "coding_agent",
});

describe("worker-process acceptance", () => {
  test("send() resolves on command_accepted", async () => {
    const entry = fixture(
      "ok.ts",
      `  const cmd = JSON.parse(line);\n  if (cmd.type === "open_session") {\n    stdout.write(JSON.stringify({ protocolVersion: 1, type: "command_accepted", commandId: cmd.commandId, backendSessionId: cmd.backendSessionId }) + "\\n");\n  }`,
    );
    const handle = spawnWorkerProcess({
      workerEntry: entry,
      env: {},
      cwd: tmp,
      stopGraceMs: 100,
      acceptTimeoutMs: 5000,
      events: noopEvents(),
    });
    const msg = (await handle.send(openCmd("s1"))) as WorkerMessage;
    expect((msg as { type: string }).type).toBe("command_accepted");
    handle.kill("SIGKILL");
  });

  test("send() rejects when the worker exits before accepting", async () => {
    const entry = fixture("exit.ts", `  process.exit(7);`);
    const handle = spawnWorkerProcess({
      workerEntry: entry,
      env: {},
      cwd: tmp,
      stopGraceMs: 100,
      acceptTimeoutMs: 5000,
      events: noopEvents(),
    });
    await expect(handle.send(openCmd("s2"))).rejects.toThrow(/exited/);
  });

  test("send() rejects on acceptance timeout", async () => {
    const entry = fixture(
      "silent.ts",
      `  // accept nothing; the readline stays open but never replies`,
    );
    const handle = spawnWorkerProcess({
      workerEntry: entry,
      env: {},
      cwd: tmp,
      stopGraceMs: 100,
      acceptTimeoutMs: 200,
      events: noopEvents(),
    });
    await expect(handle.send(openCmd("s3"))).rejects.toThrow(/timed out/);
    handle.kill("SIGKILL");
  });

  test("send() rejects on identity mismatch (wrong backendSessionId)", async () => {
    const entry = fixture(
      "mismatch.ts",
      `  const cmd = JSON.parse(line);\n  if (cmd.type === "open_session") {\n    stdout.write(JSON.stringify({ protocolVersion: 1, type: "command_accepted", commandId: cmd.commandId, backendSessionId: "other-session" }) + "\\n");\n  }`,
    );
    const handle = spawnWorkerProcess({
      workerEntry: entry,
      env: {},
      cwd: tmp,
      stopGraceMs: 100,
      acceptTimeoutMs: 5000,
      events: noopEvents(),
    });
    await expect(handle.send(openCmd("s4"))).rejects.toThrow(/identity mismatch/);
    handle.kill("SIGKILL");
  });

  test("sendForResult() resolves on the result after the intermediate accepted", async () => {
    // The Worker acks twice: command_accepted (intermediate) then
    // command_result (the real completion, e.g. compact). The pending command
    // must survive the intermediate ack or the result orphans and hangs.
    const entry = fixture(
      "two-phase.ts",
      `  const cmd = JSON.parse(line);\n  if (cmd.type === "compact") {\n    stdout.write(JSON.stringify({ protocolVersion: 1, type: "command_accepted", commandId: cmd.commandId, backendSessionId: cmd.backendSessionId }) + "\\n");\n    stdout.write(JSON.stringify({ protocolVersion: 1, type: "command_result", commandId: cmd.commandId, backendSessionId: cmd.backendSessionId, result: { compacted: true } }) + "\\n");\n  }`,
    );
    const handle = spawnWorkerProcess({
      workerEntry: entry,
      env: {},
      cwd: tmp,
      stopGraceMs: 100,
      acceptTimeoutMs: 5000,
      events: noopEvents(),
    });
    const msg = await handle.sendForResult({
      protocolVersion: 1,
      type: "compact",
      commandId: "compact-1",
      backendSessionId: "s5",
    });
    expect(msg.type).toBe("command_result");
    expect((msg as { result?: unknown }).result).toEqual({ compacted: true });
    handle.kill("SIGKILL");
  });

  test("sendForResult() rejects on acceptance timeout (no result)", async () => {
    const entry = fixture(
      "accepted-only.ts",
      `  const cmd = JSON.parse(line);\n  if (cmd.type === "compact") {\n    stdout.write(JSON.stringify({ protocolVersion: 1, type: "command_accepted", commandId: cmd.commandId, backendSessionId: cmd.backendSessionId }) + "\\n");\n  }`,
    );
    const handle = spawnWorkerProcess({
      workerEntry: entry,
      env: {},
      cwd: tmp,
      stopGraceMs: 100,
      acceptTimeoutMs: 200,
      events: noopEvents(),
    });
    await expect(
      handle.sendForResult({
        protocolVersion: 1,
        type: "compact",
        commandId: "compact-2",
        backendSessionId: "s6",
      }),
    ).rejects.toThrow(/timed out/);
    handle.kill("SIGKILL");
  });
});

void serializeMessage;
