import { childEnv } from "@chengchenccc/agent-contract";
import type { Subprocess } from "bun";
import { collectSecrets, createStderrTail, redactText, type StderrTail } from "./stderr-tail.js";

/** Process command configuration. Never a shell string: `executable` +
 *  explicit `args` only, so no argument injection is possible. Production
 *  uses `OMA_BIN ?? "oma"` with no args; tests use the Bun
 *  executable with the app entry source as the arg. */
export interface OmaCommandConfig {
  executable: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
}

export interface SpawnedOmaProcess {
  /** Child OS pid (debug logs only). */
  readonly pid: number;
  /** Strict LF-framed stdout lines (JSONL). */
  readonly stdout: AsyncIterable<string>;
  /** Redacted, bounded stderr tail (last 64 KiB). */
  readonly stderrTail: StderrTail;
  /** Resolves with the child's exit code (null when killed by signal). */
  readonly exit: Promise<number | null>;
  writeLine(line: string): void;
  closeStdin(): void;
  kill(signal?: "SIGTERM" | "SIGKILL"): void;
}

/** Strict LF-framed line reader (only \n splits frames; byte-buffered for
 *  half packets; bounded frame size). */
async function* readLines(
  stream: ReadableStream<Uint8Array>,
  onOversize: (length: number) => void,
): AsyncIterable<string> {
  const MAX_LINE_BYTES = 16 * 1024 * 1024;
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = new Uint8Array(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.length === 0) continue;
      const next = new Uint8Array(buffer.length + value.length);
      next.set(buffer, 0);
      next.set(value, buffer.length);
      buffer = next;
      if (buffer.length > MAX_LINE_BYTES) {
        buffer = buffer.slice(buffer.length - MAX_LINE_BYTES);
      }
      let start = 0;
      for (let i = 0; i < buffer.length; i++) {
        if (buffer[i] !== 0x0a) continue;
        const len = i - start;
        if (len <= MAX_LINE_BYTES) {
          yield decoder.decode(buffer.subarray(start, i));
        } else {
          onOversize(len);
        }
        start = i + 1;
      }
      buffer = buffer.slice(start);
    }
    if (buffer.length > 0) {
      if (buffer.length <= MAX_LINE_BYTES) {
        yield decoder.decode(buffer);
      } else {
        onOversize(buffer.length);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export class ProcessSpawnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcessSpawnError";
  }
}

const DEBUG_ENABLED = process.env.OMA_DEBUG === "1";

/** Spawn the oma executable. `cwd` is the Run's workspace root (the
 *  child's tools are rooted there). The child gets only a curated allowlist
 *  of parent env vars (PATH/HOME/locale + provider keys) plus the command's
 *  own env (provider keys, OMA_HOME, per-run product-tools token). */
export function spawnOmaProcess(cfg: OmaCommandConfig, opts: { cwd: string }): SpawnedOmaProcess {
  let child: Subprocess;
  try {
    child = Bun.spawn({
      cmd: [cfg.executable, ...(cfg.args ?? [])],
      cwd: opts.cwd,
      env: childEnv(cfg.env),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    throw new ProcessSpawnError(
      `failed to spawn oma executable "${cfg.executable}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const stdin = child.stdin as { write(s: string): unknown; end(): void } | null;
  const secrets = collectSecretsFor(cfg);
  const tail = createStderrTail({
    secrets,
  });
  if (child.stderr) {
    void (async () => {
      const reader = (child.stderr as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder("utf-8");
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            const text = decoder.decode(value, { stream: true });
            tail.push(text);
            // Debug tee: child logs surface on the Backend terminal, ALWAYS
            // redacted first (secrets never reach stderr).
            if (DEBUG_ENABLED) {
              process.stderr.write(`[oma:${child.pid}] ${redactText(text, secrets)}`);
            }
          }
        }
      } catch {
        /* stderr stream closing is not an error */
      } finally {
        reader.releaseLock();
      }
    })();
  }
  const exit = child.exited.then((code) => code ?? null);

  return {
    pid: child.pid,
    stdout: readLines(child.stdout as ReadableStream<Uint8Array>, () => {
      tail.push("[oma] oversized stdout line dropped\n");
    }),
    stderrTail: tail,
    exit,
    writeLine(line) {
      try {
        stdin?.write(`${line}\n`);
      } catch {
        /* child exited; writes are dropped */
      }
    },
    closeStdin() {
      try {
        stdin?.end();
      } catch {
        /* already closed */
      }
    },
    kill(signal: "SIGTERM" | "SIGKILL" = "SIGTERM") {
      try {
        child.kill(signal);
      } catch {
        /* already dead */
      }
    },
  };
}

function collectSecretsFor(cfg: OmaCommandConfig): string[] {
  // Redact against the union of the command env secrets and the well-known
  // credential keys the child inherits from the parent process env.
  const secrets = new Set(collectSecrets({ ...process.env, ...cfg.env }));
  for (const [key, value] of Object.entries(cfg.env ?? {})) {
    if (value && value.length >= 8 && /TOKEN|KEY|SECRET|PASSWORD|AUTH/i.test(key)) {
      secrets.add(value);
    }
  }
  return [...secrets];
}
