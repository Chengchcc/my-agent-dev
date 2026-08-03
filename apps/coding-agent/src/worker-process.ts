import { type Subprocess, spawn } from "bun";
import type { WorkerCommand, WorkerMessage } from "./worker-protocol.js";
import { parseWorkerMessage } from "./worker-protocol.js";

/** One supervised Worker process handle. stdout is protocol NDJSON only;
 *  stderr is diagnostics (never parsed as business events). */

export interface WorkerProcessEvents {
  onMessage(msg: WorkerMessage): void;
  onExit(code: number | null, signal: string | null): void;
  onMalformedOutput(line: string, err: unknown): void;
}

export interface WorkerProcessHandle {
  readonly pid: number;
  send(cmd: WorkerCommand): void;
  shutdown(): void;
  kill(signal?: "SIGTERM" | "SIGKILL"): void;
  readonly exited: Promise<number | null>;
}

export interface WorkerProcessOptions {
  workerEntry: string;
  env: Record<string, string>;
  cwd: string;
  stopGraceMs: number;
  events: WorkerProcessEvents;
}

export function spawnWorkerProcess(opts: WorkerProcessOptions): WorkerProcessHandle {
  const proc: Subprocess = spawn({
    cmd: ["bun", opts.workerEntry],
    env: opts.env,
    cwd: opts.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

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
            opts.events.onMessage(parseWorkerMessage(line));
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
        // stderr is diagnostics only; never parsed as protocol
        const text = new TextDecoder().decode(value);
        if (text.trim()) process.stderr.write(`[worker ${proc.pid}] ${text}`);
      }
    }
  })();

  exited
    .then((code) => opts.events.onExit(code, null))
    .catch(() => {
      opts.events.onExit(null, null);
    });

  let shuttingDown = false;

  return {
    pid: proc.pid!,
    send(cmd) {
      const stdin = proc.stdin as unknown as { write(chunk: string): void } | null;
      stdin?.write(`${JSON.stringify(cmd)}\n`);
    },
    shutdown() {
      if (shuttingDown) return;
      shuttingDown = true;
      const stdin = proc.stdin as unknown as { write(chunk: string): void } | null;
      stdin?.write(
        `${JSON.stringify({
          protocolVersion: 1,
          type: "shutdown",
          commandId: `shutdown-${Date.now()}`,
          backendSessionId: "shutdown",
        })}\n`,
      );
      // Grace period, then escalate
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
