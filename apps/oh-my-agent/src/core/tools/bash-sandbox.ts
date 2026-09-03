/** Bash launch strategy (design: docs/superpowers/specs/2026-09-03-bash-sandbox-design.md).
 * A sandbox wraps the actual spawn so the OS can enforce filesystem + network
 * boundaries on the running process and its children. P1 ships only the Null
 * implementation (current behavior, made explicit); Seatbelt (macOS) and
 * Bwrap (Linux) land with the networked-deployment gate (ADR 0026 follow-up). */

/** Same shape as the Bun spawn bash.ts consumes: streamable stdout/stderr,
 * exit promise, process-group kill. */
export interface BashSpawn {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(): void;
}

export interface BashSandbox {
  /** Workspace root the command is (eventually) confined to. */
  readonly workspaceRoot: string;
  spawn(command: string, opts: { cwd: string; env?: Readonly<Record<string, string>> }): BashSpawn;
}

/** Current behavior, made explicit: plain `bash -c` with a validated cwd, no
 * OS-level confinement (ADR 0026 semi-trusted baseline). Setsid gives us a
 * killable process group when available. */
export class NullBashSandbox implements BashSandbox {
  readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  spawn(command: string, opts: { cwd: string; env?: Readonly<Record<string, string>> }): BashSpawn {
    const hasSetsid = Bun.which("setsid") !== null;
    const proc = Bun.spawn(
      hasSetsid ? ["setsid", "bash", "-c", command] : ["bash", "-c", command],
      {
        stdout: "pipe",
        stderr: "pipe",
        cwd: opts.cwd,
        ...(opts.env ? { env: opts.env } : {}),
      },
    );
    return {
      stdout: proc.stdout,
      stderr: proc.stderr,
      exited: proc.exited,
      kill: () => {
        proc.kill();
        try {
          process.kill(-proc.pid!, "SIGKILL");
        } catch {
          /* not a group leader */
        }
      },
    };
  }
}
