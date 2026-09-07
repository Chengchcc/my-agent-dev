/** @chengchenccc/sandbox — process-isolated execution of untrusted scripts.
 *
 *  A script is a TS/JS module with `export default async (ctx) => output`.
 *  It runs in a spawned `bun` subprocess with its own temp directory as cwd,
 *  a minimal environment, a hard timeout (process tree kill), and a JSON
 *  stdio contract: input on stdin, output on the last stdout line marked
 *  `__SANDBOX_OUTPUT__`. Callers never share memory, modules, or handles
 *  with the script.
 *
 *  Isolation level: process boundary (crash/resource/timeout isolation,
 *  no access to host objects). It is NOT a filesystem/network jail — a
 *  hostile script can still touch the host filesystem like any spawned
 *  process. Container-level isolation is a deliberate non-goal here. */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface SandboxInput {
  /** The script source (TS/JS module). Must `export default (ctx) => output`. */
  code: string;
  /** JSON-serializable context passed to the script (stdin). */
  input?: Record<string, unknown>;
  /** Hard timeout in ms. Default 30_000. Kills the process tree. */
  timeoutMs?: number;
  /** Extra env vars merged over the minimal base (PATH/HOME/LANG). */
  env?: Record<string, string>;
  /** Persistent dir for the script's files (cwd). Default: a fresh temp dir. */
  cwd?: string;
  /** Keep the working dir after the run (default: removed). */
  keepCwd?: boolean;
  /** H2: OS-level isolation knobs. When requested and a wrapper tool is
   *  available (Linux: bwrap, macOS: sandbox-exec) the subprocess runs
   *  inside it; without a tool the run falls back to process isolation
   *  only, with a warning naming the ceiling. */
  isolation?: {
    /** Cut all network access (unshare-net / deny network*). */
    noNetwork?: boolean;
    /** Directories the script must not read: overlaid with an empty tmpfs
     *  (bwrap) or denied by profile (sandbox-exec). Non-existent dirs are
     *  skipped. */
    denyReadDirs?: readonly string[];
  };
}

export interface SandboxResult {
  /** The script's returned value (parsed JSON), or null when it returned nothing. */
  output: Record<string, unknown> | null;
  /** Raw stdout (without the output marker line). */
  stdout: string;
  /** Raw stderr. */
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

const BASE_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  HOME: tmpdir(),
  LANG: process.env.LANG ?? "en_US.UTF-8",
};

/** The wrapper that runs inside the subprocess. It reads ctx from stdin,
 *  imports the user module, awaits the default export, and prints the
 *  result as a marked JSON line for the parent to parse. */
const WRAPPER = `
const fs = await import("node:fs");
const path = await import("node:path");
const inputRaw = fs.readFileSync(0, "utf8");
let ctx = {};
try { ctx = JSON.parse(inputRaw || "{}"); } catch { ctx = {}; }
const mod = await import(path.resolve("./script.ts") + "?t=" + Date.now());
const fn = mod.default;
if (typeof fn !== "function") {
  console.error("sandbox script must export default a function");
  process.exit(2);
}
try {
  const out = await fn(ctx);
  if (out !== undefined && out !== null) {
    process.stdout.write("__SANDBOX_OUTPUT__:" + JSON.stringify(out) + "\\n");
  }
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
}
`;

function bwrapArgv(base: readonly string[], isolation: SandboxInput["isolation"]): string[] {
  const args = ["bwrap", "--dev-bind", "/", "/"];
  if (isolation?.noNetwork) args.push("--unshare-net");
  for (const d of isolation?.denyReadDirs ?? []) {
    // bwrap needs an existing mountpoint; an empty tmpfs over the dir
    // shadows its content (reads AND writes).
    if (existsSync(d)) args.push("--tmpfs", d);
  }
  args.push(...base);
  return args;
}

function sandboxExecArgv(
  base: readonly string[],
  dir: string,
  isolation: SandboxInput["isolation"],
): string[] {
  const denies = (isolation?.denyReadDirs ?? [])
    .map((d) => `(deny file-read-data (subpath "${d}"))`)
    .join("");
  const net = isolation?.noNetwork ? "(deny network*)" : "";
  const profilePath = join(dir, "__sandbox_profile.sb");
  writeFileSync(profilePath, `(version 1)(allow default)${net}${denies}`);
  return ["sandbox-exec", "-f", profilePath, ...base];
}

/** Post-exit drain grace: fires only when the pipe is still open (an
 *  orphaned grandchild holds it) — buffered data resolves instantly. */
function stallAfter(ms: number): Promise<"stalled"> {
  const { promise, resolve } = Promise.withResolvers<"stalled">();
  const t = setTimeout(() => resolve("stalled"), ms);
  t.unref?.();
  return promise;
}

/** Depth-first descendant reap for platforms without setsid (H3): pgrep -P
 *  per generation, grandchildren killed before their parents so nothing
 *  re-parents and survives. Best effort — a missing pgrep degrades to the
 *  direct-child kill only. */
function killDescendants(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  let kids: number[];
  try {
    kids = Bun.spawnSync(["pgrep", "-P", String(pid)])
      .stdout.toString()
      .split("\n")
      .flatMap((line) => {
        const n = Number(line.trim());
        return Number.isInteger(n) && n > 0 ? [n] : [];
      });
  } catch {
    return;
  }
  for (const kid of kids) killDescendants(kid, signal);
  for (const kid of kids) {
    try {
      process.kill(kid, signal);
    } catch {
      /* already gone */
    }
  }
}

export async function runInSandbox(input: SandboxInput): Promise<SandboxResult> {
  const timeoutMs = input.timeoutMs ?? 30_000;
  const dir = input.cwd ?? mkTempDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "script.ts"), input.code);
  writeFileSync(join(dir, "__sandbox_main.ts"), WRAPPER);
  let timedOut = false;
  // Cap buffered output: a hostile `while(true) console.log(...)` would
  // otherwise OOM the backend before the timeout fires.
  const MAX_STREAM_BYTES = 10 * 1024 * 1024;
  async function cappedText(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let exitedSeen = false;
    for (;;) {
      const read = reader.read();
      // During the run: wait on data OR process exit. Losing to exit means
      // EOF is pending (H3: an orphaned grandchild inheriting the pipe can
      // hold it open forever) — switch to the bounded drain below.
      const res = exitedSeen
        ? await Promise.race([read, stallAfter(1_000)])
        : await Promise.race([read, exited.then(() => "exited" as const)]);
      if (res === "exited") {
        exitedSeen = true;
        continue;
      }
      if (res === "stalled" || res.done) {
        // Post-exit the kernel buffer delivers instantly; stalling past the
        // grace means an orphan still holds the pipe — cancel and use what
        // we got instead of hanging on EOF.
        if (res === "stalled") reader.cancel().catch(() => {});
        break;
      }
      total += res.value.byteLength;
      if (total <= MAX_STREAM_BYTES) chunks.push(res.value);
    }
    const buf = Buffer.concat(chunks).toString("utf8");
    return total > MAX_STREAM_BYTES
      ? `${buf.slice(0, MAX_STREAM_BYTES)}\n[sandbox: output truncated at ${MAX_STREAM_BYTES} bytes]`
      : buf;
  }
  // Own process group: the timeout must reap grandchildren too, and a
  // script that traps SIGTERM needs a SIGKILL escalation (a lone
  // proc.kill() SIGTERM left executions stuck in "running" forever).
  const hasSetsid = Bun.which("setsid") !== null;
  // H2: wrap the script process when isolation is requested and a wrapper
  // tool exists for the platform; otherwise fall back to process isolation
  // only, with a warning naming the ceiling.
  const isolation = input.isolation;
  const wantsNetworkCut = isolation?.noNetwork === true;
  const wantsDenyRead = (isolation?.denyReadDirs?.length ?? 0) > 0;
  const isolationRequested = wantsNetworkCut || wantsDenyRead;
  const onLinux = process.platform === "linux";
  const onMacos = process.platform === "darwin";
  const hasBwrap = Bun.which("bwrap") !== null;
  const hasSandboxExec = Bun.which("sandbox-exec") !== null;
  let baseArgv = ["bun", "run", join(dir, "__sandbox_main.ts")];
  if (isolationRequested) {
    if (onLinux && hasBwrap) {
      baseArgv = bwrapArgv(baseArgv, isolation);
    } else if (onMacos && hasSandboxExec) {
      baseArgv = sandboxExecArgv(baseArgv, dir, isolation);
    } else {
      console.warn(
        "[sandbox] isolation requested but no bwrap/sandbox-exec available — running with process isolation only",
      );
    }
  }
  const argv = hasSetsid ? ["setsid", ...baseArgv] : baseArgv;
  const proc = Bun.spawn(argv, {
    cwd: dir,
    env: { ...BASE_ENV, ...(input.env ?? {}) },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin!.write(JSON.stringify(input.input ?? {}));
  proc.stdin!.end();
  const exited = proc.exited;
  try {
    const killTree = (signal: "SIGTERM" | "SIGKILL") => {
      // Group kill first (setsid made the child a leader); fall back to
      // direct child + a depth-first descendant reap when no group exists
      // (macOS has no setsid).
      try {
        process.kill(-proc.pid!, signal);
      } catch {
        proc.kill(signal);
        killDescendants(proc.pid!, signal);
      }
    };
    let escalation: Timer | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
      escalation = setTimeout(() => killTree("SIGKILL"), 2_000);
      escalation.unref?.();
    }, timeoutMs);
    // H3: completion is gated on proc.exited, NEVER on pipe EOF.
    const exitCode = await exited;
    clearTimeout(timer);
    clearTimeout(escalation);
    const [stdout, stderr] = await Promise.all([
      cappedText(proc.stdout as ReadableStream<Uint8Array>),
      cappedText(proc.stderr as ReadableStream<Uint8Array>),
    ]);
    const marker = stdout.lastIndexOf("__SANDBOX_OUTPUT__:");
    let output: Record<string, unknown> | null = null;
    let cleanStdout = stdout;
    if (marker !== -1) {
      const line = stdout.slice(marker + "__SANDBOX_OUTPUT__:".length).trim();
      cleanStdout = stdout.slice(0, marker).trimEnd();
      try {
        output = JSON.parse(line) as Record<string, unknown>;
      } catch {
        output = null;
      }
    }
    if (timedOut) {
      throw new SandboxTimeoutError(timeoutMs);
    }
    return { output, stdout: cleanStdout, stderr, exitCode, timedOut };
  } finally {
    if (!input.keepCwd && !input.cwd) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

export class SandboxTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`sandbox script timed out after ${timeoutMs}ms`);
    this.name = "SandboxTimeoutError";
  }
}

function mkTempDir(): string {
  return resolve(
    tmpdir(),
    `sandbox-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );
}
