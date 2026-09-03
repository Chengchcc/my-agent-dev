/** Bash launch strategy (design: docs/superpowers/specs/2026-09-03-bash-sandbox-design.md).
 * A sandbox wraps the actual spawn so the OS can enforce filesystem + network
 * boundaries on the running process and its children. Null = current
 * unconstrained behavior; Bwrap (Linux) = bubblewrap OS confinement. */

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

/** Linux confinement via bubblewrap: system tree read-only, workspace the only
 * writable bind, /tmp a private tmpfs, network namespace unshared (no
 * egress). bwrap requires setuid or user namespaces; unavailability throws
 * at spawn time (the caller falls back to the approval pipeline). */
export class BwrapBashSandbox implements BashSandbox {
  readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  spawn(command: string, opts: { cwd: string; env?: Readonly<Record<string, string>> }): BashSpawn {
    // Order matters: --tmpfs /tmp would shadow a workspace bound under /tmp,
    // so the workspace bind comes after it (probed on bwrap 0.8).
    const proc = Bun.spawn(
      [
        "bwrap",
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--tmpfs",
        "/tmp",
        "--bind",
        this.workspaceRoot,
        this.workspaceRoot,
        "--unshare-net",
        "--die-with-parent",
        "bash",
        "-c",
        command,
      ],
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

/** Pick the launch strategy. enabled=false → Null (explicit current
 * behavior); Linux → Bwrap when bubblewrap is installed. Throws on
 * enabled-but-missing so the caller can surface "sandbox requested but
 * unavailable" instead of silently running unconstrained. */
export function resolveBashSandbox(opts: {
  workspaceRoot: string;
  enabled: boolean;
  platform?: NodeJS.Platform;
}): BashSandbox {
  if (!opts.enabled) return new NullBashSandbox(opts.workspaceRoot);
  const platform = opts.platform ?? process.platform;
  if (platform === "linux") {
    if (Bun.which("bwrap") === null) {
      throw new Error(
        "bash sandbox requested but bubblewrap is not installed (apt install bubblewrap)",
      );
    }
    return new BwrapBashSandbox(opts.workspaceRoot);
  }
  throw new Error(`bash sandbox not implemented for platform ${platform} (Seatbelt/macOS is P2)`);
}
