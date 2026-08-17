/** Spawn the omp CLI. Same shape as adapter-oma-agent's process helper
 *  (LF-framed stdout lines, bounded stderr tail) but no secrets redaction —
 *  omp has no token-bearing env vars of its own. */

import { collectSecrets, redactText } from "@chengchenccc/agent-backend";
import type { Subprocess } from "bun";

export interface OmpCommandConfig {
  executable: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
}

export interface SpawnedOmpProcess {
  readonly pid: number;
  /** Strict LF-framed stdout lines (JSONL). */
  readonly stdout: AsyncIterable<string>;
  /** Bounded stderr tail (last 64 KiB) for crash diagnostics. */
  readonly stderrTail: string;
  /** Resolves with the child's exit code (null when killed by signal). */
  readonly exit: Promise<number | null>;
  kill(signal?: "SIGTERM" | "SIGKILL"): void;
}

/** Strict LF-framed line reader (only \n splits frames; byte-buffered for
 *  half packets; bounded frame size). */
async function* readLines(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const MAX_FRAME = 10 * 1024 * 1024;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl === -1) break;
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.length > MAX_FRAME) continue; // malformed oversize frame: drop
      yield line;
    }
  }
  if (buffer.length > 0) yield buffer;
}

export function spawnOmpProcess(cfg: OmpCommandConfig, opts: { cwd: string }): SpawnedOmpProcess {
  let stderrTail = "";
  // Secrets captured from the child env: a crashed CLI echoing its
  // environment must never leak keys into the persistent tail.
  const secrets = collectSecrets(cfg.env ?? {});
  // Same as the pi adapter: a leaked OMP_DAEMON_* pair from the hosting
  // harness routes the omp worker at the wrong daemon and hangs the run.
  const env: Record<string, string | undefined> = { ...process.env, ...cfg.env };
  delete env.OMP_DAEMON_PROJECT_DIR;
  delete env.OMP_DAEMON_RUNTIME_DIR;
  const proc: Subprocess = Bun.spawn({
    cmd: [cfg.executable, ...(cfg.args ?? [])],
    cwd: opts.cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  void (async () => {
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stderrTail = redactText((stderrTail + decoder.decode(value)).slice(-64 * 1024), secrets);
    }
  })();

  return {
    pid: proc.pid,
    stdout: readLines(proc.stdout as ReadableStream<Uint8Array>),
    get stderrTail() {
      return stderrTail;
    },
    exit: proc.exited,
    kill: (signal) => proc.kill(signal),
  };
}
