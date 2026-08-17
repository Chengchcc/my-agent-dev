/** Spawn the claude CLI with a stdin pipe: one stream-json user message is
 *  written, then stdin closes (`-p` mode reads stdin and exits). Same
 *  LF-framed stdout reader + bounded stderr tail as the other adapters. */

import { collectSecrets, redactText } from "@chengchenccc/agent-backend";
import type { FileSink, Subprocess } from "bun";

export interface ClaudeCommandConfig {
  executable: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
}

export interface SpawnedClaudeProcess {
  readonly pid: number;
  /** Strict LF-framed stdout lines (JSONL). */
  readonly stdout: AsyncIterable<string>;
  /** Bounded stderr tail (last 64 KiB) for crash diagnostics. */
  readonly stderrTail: string;
  /** Resolves with the child's exit code (null when killed by signal). */
  readonly exit: Promise<number | null>;
  /** Write one stdin line (the stream-json user message). */
  writeLine(line: string): void;
  /** Close stdin — the `-p` run ends after the input is consumed. */
  closeStdin(): void;
  kill(signal?: "SIGTERM" | "SIGKILL"): void;
}

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
      if (line.length > MAX_FRAME) continue;
      yield line;
    }
  }
  if (buffer.length > 0) yield buffer;
}

export function spawnClaudeProcess(
  cfg: ClaudeCommandConfig,
  opts: { cwd: string },
): SpawnedClaudeProcess {
  let stderrTail = "";
  // Secrets captured from the child env: a crashed CLI echoing its
  // environment must never leak keys into the persistent tail.
  const secrets = collectSecrets(cfg.env ?? {});
  const proc: Subprocess = Bun.spawn({
    cmd: [cfg.executable, ...(cfg.args ?? [])],
    cwd: opts.cwd,
    env: { ...process.env, ...cfg.env },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "pipe",
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
    writeLine: (line) => (proc.stdin as FileSink).write(`${line}\n`),
    closeStdin: () => (proc.stdin as FileSink).end(),
    kill: (signal) => proc.kill(signal),
  };
}
