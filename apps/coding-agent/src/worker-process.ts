import { type Subprocess, spawn } from "bun";
import type { WorkerCommand, WorkerMessage } from "./worker-protocol.js";
import { parseWorkerMessage } from "./worker-protocol.js";

/** One supervised Worker process handle. stdout is protocol NDJSON only;
 *  stderr is diagnostics (never parsed as business events).
 *
 *  `send(cmd)` returns a Promise that resolves when the Worker acknowledges
 *  the command (command_accepted / command_result) and rejects on
 *  command_error, fatal output, process exit, or an acceptance timeout. This
 *  is the Backend-accept invariant: an HTTP mutation does not return success
 *  until the Worker has accepted the command. */

export interface WorkerProcessEvents {
  onMessage(msg: WorkerMessage): void;
  onExit(code: number | null, signal: string | null): void;
  onMalformedOutput(line: string, err: unknown): void;
}

interface PendingCommand {
  commandId: string;
  backendSessionId: string;
  runId?: string;
  /** "accepted": resolve on the first command_accepted (default). "result":
   *  skip the intermediate accepted and resolve only on command_result - for
   *  commands whose real completion is the result (compact). */
  waitFor: "accepted" | "result";
  resolve(msg: WorkerMessage): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface WorkerProcessHandle {
  readonly pid: number;
  /** Send a command and await the Worker's acceptance. Resolves on
   *  command_accepted/command_result (identity verified), rejects on
   *  command_error/fatal/exit/timeout. */
  send(cmd: WorkerCommand): Promise<WorkerMessage>;
  /** Send a command and await its command_result (skipping the intermediate
   *  accepted) - for commands whose completion is the result, e.g. compact. */
  sendForResult(cmd: WorkerCommand): Promise<WorkerMessage>;
  /** Fire-and-forget write (control inputs that bypass acceptance, e.g.
   *  shutdown). */
  post(cmd: WorkerCommand): void;
  shutdown(): void;
  kill(signal?: "SIGTERM" | "SIGKILL"): void;
  readonly exited: Promise<number | null>;
}

export interface WorkerProcessOptions {
  workerEntry: string;
  env: Record<string, string>;
  cwd: string;
  stopGraceMs: number;
  /** Max ms to await command acceptance before rejecting the mutation. */
  acceptTimeoutMs: number;
  events: WorkerProcessEvents;
}

export function spawnWorkerProcess(opts: WorkerProcessOptions): WorkerProcessHandle {
  const proc: Subprocess = spawn({
    cmd: [process.execPath, opts.workerEntry],
    env: opts.env,
    cwd: opts.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const pending = new Map<string, PendingCommand>();

  function failPending(err: Error): void {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
  }

  /** Resolve/reject a pending command from an accepted/result/error message.
   *  Verifies backendSessionId + runId match the command (identity). Returns
   *  true if the message was consumed as a command reply. */
  function settle(msg: WorkerMessage): boolean {
    const commandId = "commandId" in msg ? msg.commandId : undefined;
    if (!commandId) return false;
    const p = pending.get(commandId);
    if (!p) return false;
    // waitFor "result": command_accepted is only the intermediate ack - KEEP
    // the pending command (and its timer) until the real command_result
    // arrives. Deleting here would orphan the result and hang the promise.
    if (p.waitFor === "result" && msg.type === "command_accepted") return false;
    pending.delete(commandId);
    clearTimeout(p.timer);

    if (msg.type === "command_accepted" || msg.type === "command_result") {
      // Identity check: the reply must be for the same session (and run, when
      // both carry one). A crossed/forgeed reply rejects the mutation.
      if (msg.backendSessionId !== p.backendSessionId) {
        p.reject(
          new Error(
            `identity mismatch: expected session ${p.backendSessionId}, got ${msg.backendSessionId}`,
          ),
        );
        return true;
      }
      if ("runId" in msg && p.runId !== undefined && msg.runId !== p.runId) {
        p.reject(new Error(`identity mismatch: expected run ${p.runId}, got ${msg.runId}`));
        return true;
      }
      p.resolve(msg);
      return true;
    }
    if (msg.type === "command_error" || msg.type === "fatal") {
      p.reject(new Error(msg.message));
      return true;
    }
    return false;
  }

  let buf = "";
  const exited = proc.exited as Promise<number | null>;

  (async () => {
    const stdoutStream = proc.stdout as ReadableStream<Uint8Array> | null;
    const stdoutReader = stdoutStream?.getReader();
    if (stdoutReader) {
      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) break;
        buf += new TextDecoder().decode(value);
        for (;;) {
          const idx = buf.indexOf("\n");
          if (idx < 0) break;
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            const msg = parseWorkerMessage(line);
            // Command replies settle pending acceptances first; all messages
            // (events, outcomes, accepted) still forward to the supervisor.
            settle(msg);
            opts.events.onMessage(msg);
          } catch (err) {
            opts.events.onMalformedOutput(line, err);
          }
        }
      }
    }
  })();

  (async () => {
    const stderrStream = proc.stderr as ReadableStream<Uint8Array> | null;
    const stderrReader = stderrStream?.getReader();
    if (stderrReader) {
      while (true) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        const text = new TextDecoder().decode(value);
        if (text.trim()) process.stderr.write(`[worker ${proc.pid}] ${text}`);
      }
    }
  })();

  exited
    .then((code) => {
      failPending(new Error(`worker exited before accepting (code ${code})`));
      opts.events.onExit(code, null);
    })
    .catch(() => {
      failPending(new Error("worker exited abnormally"));
      opts.events.onExit(null, null);
    });

  function writeCmd(cmd: WorkerCommand): void {
    const stdin = proc.stdin as unknown as { write(chunk: string): void } | null;
    stdin?.write(`${JSON.stringify(cmd)}\n`);
  }

  function sendCommand(cmd: WorkerCommand, waitFor: "accepted" | "result"): Promise<WorkerMessage> {
    const commandId = cmd.commandId;
    const backendSessionId = cmd.backendSessionId;
    const runId = "runId" in cmd ? cmd.runId : undefined;
    // Duplicate in-flight commandId: reject instead of overwriting the first
    // resolver (a retried mutation must not corrupt the original's outcome).
    if (pending.has(commandId)) {
      return Promise.reject(new Error(`duplicate in-flight command: ${commandId}`));
    }
    return new Promise<WorkerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(commandId);
        reject(new Error(`command ${waitFor} timed out: ${commandId}`));
      }, opts.acceptTimeoutMs);
      pending.set(commandId, {
        commandId,
        backendSessionId,
        runId,
        waitFor,
        resolve,
        reject,
        timer,
      });
      writeCmd(cmd);
    });
  }

  let shuttingDown = false;

  return {
    pid: proc.pid!,
    send(cmd) {
      return sendCommand(cmd, "accepted");
    },
    sendForResult(cmd) {
      return sendCommand(cmd, "result");
    },
    post(cmd) {
      writeCmd(cmd);
    },
    shutdown() {
      if (shuttingDown) return;
      shuttingDown = true;
      writeCmd({
        protocolVersion: 1,
        type: "shutdown",
        commandId: `shutdown-${proc.pid}`,
        backendSessionId: "shutdown",
      });
      setTimeout(() => {
        try {
          proc.kill("SIGTERM");
        } catch {
          /* already gone */
        }
        setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }, opts.stopGraceMs);
      }, opts.stopGraceMs);
    },
    kill(signal = "SIGTERM") {
      try {
        proc.kill(signal);
      } catch {
        /* already gone */
      }
    },
    exited,
  };
}
