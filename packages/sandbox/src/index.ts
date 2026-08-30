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

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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

export async function runInSandbox(input: SandboxInput): Promise<SandboxResult> {
  const timeoutMs = input.timeoutMs ?? 30_000;
  const dir = input.cwd ?? mkTempDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "script.ts"), input.code);
  writeFileSync(join(dir, "__sandbox_main.ts"), WRAPPER);
  let timedOut = false;
  try {
    const proc = Bun.spawn(["bun", "run", join(dir, "__sandbox_main.ts")], {
      cwd: dir,
      env: { ...BASE_ENV, ...(input.env ?? {}) },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin!.write(JSON.stringify(input.input ?? {}));
    proc.stdin!.end();
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
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
