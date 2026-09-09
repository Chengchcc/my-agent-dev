import { childEnv } from "@chengchenccc/agent-contract";
import type { Tool } from "@chengchenccc/message";
import type { BashSandbox } from "./bash-sandbox.js";
import { NullBashSandbox } from "./bash-sandbox.js";
import { WorkspaceSandbox } from "./workspace-sandbox.js";

const descriptionParam = {
  type: "string" as const,
  description:
    "Must be the first parameter. A short human-readable summary explaining why this command is being run.",
};

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function defaultBashTimeoutMs(): number {
  return envMs("OMA_BASH_TIMEOUT_MS", 30_000);
}

function maxToolTimeoutMs(): number {
  return envMs("OMA_MAX_TOOL_TIMEOUT_MS", 0);
}

/** M10: cap captured output — a runaway `yes` must OOM neither the child
 *  nor this process. Streams to onOutput keep flowing; accumulation stops. */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

async function cappedText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total <= MAX_OUTPUT_BYTES) out += decoder.decode(value, { stream: true });
  }
  return total > MAX_OUTPUT_BYTES ? `${out}\n[output truncated at ${MAX_OUTPUT_BYTES} bytes]` : out;
}

// ─── Background jobs (M-bash) ──────────────────────────────────────────

interface BashJob {
  id: string;
  command: string;
  proc: { kill(): void; exited: Promise<number | null> };
  output: string;
  truncated: boolean;
  bytes: number;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  timedOut: boolean;
  killed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** Wrap a command so it runs with a real pseudo-terminal (script -e keeps
 *  the exit code). util-linux (Linux) and BSD script (macOS) differ. */
function ptyWrap(command: string): string | null {
  const script = Bun.which("script");
  if (!script) return null;
  if (process.platform === "darwin") {
    return `${script} -q /dev/null ${shellQuote(command)}`;
  }
  return `${script} -qec ${shellQuote(command)} /dev/null`;
}

export function createBashTool(opts: {
  workspaceRoot: string;
  /** Launch strategy; default Null = current unconstrained behavior. */
  sandbox?: BashSandbox;
}): Tool {
  const sandbox = new WorkspaceSandbox(opts.workspaceRoot);
  const launcher = opts.sandbox ?? new NullBashSandbox(opts.workspaceRoot);

  // Background job registry (per tool instance = per Run lifetime).
  const jobs = new Map<string, BashJob>();
  let nextJobSeq = 1;
  const MAX_JOBS = 32;

  function startJob(
    command: string,
    cwd: string,
    env: Record<string, string>,
    timeoutMs: number,
  ): BashJob {
    const id = `bg_${nextJobSeq++}`;
    const proc = launcher.spawn(command, { cwd, env });
    const job: BashJob = {
      id,
      command,
      proc,
      output: "",
      truncated: false,
      bytes: 0,
      startedAt: Date.now(),
      finishedAt: null,
      exitCode: null,
      timedOut: false,
      killed: false,
      timer: null,
    };
    jobs.set(id, job);
    const pump = (stream: ReadableStream<Uint8Array>) => {
      void (async () => {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          job.bytes += value.byteLength;
          if (job.bytes <= MAX_OUTPUT_BYTES) job.output += decoder.decode(value, { stream: true });
          else job.truncated = true;
        }
      })();
    };
    pump(proc.stdout);
    pump(proc.stderr);
    if (timeoutMs > 0) {
      job.timer = setTimeout(() => {
        job.timedOut = true;
        job.proc.kill();
      }, timeoutMs);
    }
    void proc.exited
      .then((code) => {
        job.exitCode = code;
        job.finishedAt = Date.now();
        if (job.timer) clearTimeout(job.timer);
      })
      .catch(() => {
        job.finishedAt = Date.now();
        if (job.timer) clearTimeout(job.timer);
      });
    return job;
  }

  function jobSummary(job: BashJob): string {
    const state = job.finishedAt === null ? "running" : "completed";
    const secs = Math.round(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000);
    const flag = job.timedOut ? ", timed out" : job.killed ? ", killed" : "";
    const lines = [`job ${job.id} [${state}${flag}] ${secs}s`, `command: ${job.command}`];
    if (job.truncated) lines.push(`[output truncated at ${MAX_OUTPUT_BYTES} bytes]`);
    lines.push(job.output.length > 0 ? job.output : "(no output)");
    if (job.finishedAt !== null && job.exitCode !== null && job.exitCode !== 0) {
      lines.push(`Command exited with code ${job.exitCode}`);
    }
    return lines.join("\n");
  }

  return {
    name: "bash",
    description:
      "Execute a bash shell command. Returns exit code, stdout, and stderr. Default timeout 30s, max 600s. " +
      "Supports background execution (async) with polling via jobAction, and pseudo-terminal mode (pty) " +
      "for commands that need a real TTY.",
    inputSchema: {
      type: "object",
      properties: {
        description: descriptionParam,
        command: {
          type: "string",
          description: "The shell command to execute (omit when jobAction is set)",
        },
        async: {
          type: "boolean",
          description:
            "Run in the background: returns a job id immediately. Poll output with jobAction=output; " +
            "the job keeps running until its timeout.",
        },
        pty: {
          type: "boolean",
          description:
            "Run under a pseudo-terminal (for commands that need a real TTY: colors, progress bars, " +
            "TUI programs). Ignored when async is true. Falls back with a notice when no pty tool exists.",
        },
        jobAction: {
          type: "string",
          enum: ["list", "output", "kill"],
          description:
            "Manage background jobs: list all, get one job's output/status (needs jobId), or kill it (needs jobId).",
        },
        jobId: {
          type: "string",
          description: "Background job id (bg_N) for jobAction=output/kill",
        },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds (default 30000, max 600000)",
        },
        cwd: {
          type: "string",
          description: "Working directory (relative to workspace root)",
        },
      },
      required: ["description", "command"],
    },
    async execute(input, signal?: AbortSignal, options?: { onOutput?: (s: string) => void }) {
      const {
        command,
        timeout = defaultBashTimeoutMs(),
        cwd,
        pty = false,
        jobAction,
        jobId,
      } = input as {
        command: string;
        timeout?: number;
        cwd?: string;
        pty?: boolean;
        jobAction?: "list" | "output" | "kill";
        jobId?: string;
      };

      const upper = maxToolTimeoutMs();
      const cap = upper > 0 ? Math.min(upper, 600_000) : 600_000;
      const clamped = Math.min(Math.max(timeout, 1), cap);

      // Background job management (M-bash): polling surface for jobs the
      // model started with async=true. No command needed.
      if (jobAction) {
        if (jobAction === "list") {
          if (jobs.size === 0) return { content: "(no background jobs)" };
          const rows = [...jobs.values()].map((j) => {
            const state = j.finishedAt === null ? "running" : "completed";
            return `${j.id} [${state}] ${j.command}`;
          });
          return { content: rows.join("\n") };
        }
        const target = jobId ? jobs.get(jobId) : undefined;
        if (!target) return { content: `Error: unknown job: ${jobId ?? "(none)"}`, isError: true };
        if (jobAction === "kill") {
          if (target.finishedAt === null) {
            target.killed = true;
            target.proc.kill();
          }
          return { content: `Killed ${target.id}` };
        }
        return { content: jobSummary(target) };
      }

      if (!command) {
        return { content: "Error: command is required", isError: true };
      }
      // Validate cwd against the fixed workspace sandbox. Out-of-bounds cwd
      // is a tool error, never a silent fallback to process cwd.
      let validatedCwd = opts.workspaceRoot;
      if (cwd) {
        try {
          validatedCwd = sandbox.validateCwd(cwd);
        } catch {
          return {
            content: `Error: cwd escapes workspace root: ${cwd}`,
            isError: true,
          };
        }
      }
      // Strip credential-shaped vars from the inherited env: the bash child
      // needs tooling (PATH/HOME/LANG/TZ), not provider keys or the per-run
      // product-tools token. Full inheritance let one `env`/`printenv` read
      // every secret the oma process holds, voiding the childEnv allowlist
      // and stderr redaction above it.
      const BASH_ENV_DENY = /API_KEY|AUTH_TOKEN|_TOKEN$|_SECRET$|PASSWORD|PASSWD/;
      const bashEnv: Record<string, string> = Object.fromEntries(
        Object.entries(childEnv()).filter(([k]) => !BASH_ENV_DENY.test(k)),
      );

      // Background execution (M-bash): return a job id immediately; the
      // model polls via jobAction=output. pty does not apply to jobs.
      let notice = "";
      let effectiveCommand = command;
      if (pty) {
        const wrapped = ptyWrap(command);
        if (wrapped === null) {
          notice = "pty requested but unavailable in this environment; ran without a terminal";
        } else {
          effectiveCommand = wrapped;
          bashEnv.TERM = "xterm-256color";
        }
      }
      if ((input as { async?: boolean }).async === true) {
        if (jobs.size >= MAX_JOBS) {
          return {
            content:
              `Error: too many background jobs (${jobs.size}/${MAX_JOBS}); ` +
              `collect or kill existing jobs first (jobAction=list/output/kill)`,
            isError: true,
          };
        }
        const job = startJob(effectiveCommand, validatedCwd, bashEnv, clamped);
        const tail = job.output.length > 0 ? `${job.output.slice(-2000)}\n` : "";
        return {
          content: `${tail}Backgrounded as job ${job.id}; fetch output with bash { "jobAction": "output", "jobId": "${job.id}" }.`,
        };
      }
      const proc = launcher.spawn(effectiveCommand, { cwd: validatedCwd, env: bashEnv });

      // Kill the process group on timeout OR abort signal.
      const killGroup = () => proc.kill();
      const timer = setTimeout(killGroup, clamped);
      const onAbort = () => killGroup();
      if (signal?.aborted) killGroup();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const stderrPromise = cappedText(proc.stderr);
        let stdout = "";
        if (options?.onOutput) {
          const reader = proc.stdout.getReader();
          const decoder = new TextDecoder();
          let total = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            total += value.byteLength;
            if (total <= MAX_OUTPUT_BYTES) {
              stdout += chunk;
              options.onOutput(chunk);
            }
          }
          if (total > MAX_OUTPUT_BYTES) {
            stdout += `\n[output truncated at ${MAX_OUTPUT_BYTES} bytes]`;
          }
        } else {
          stdout = await cappedText(proc.stdout);
        }
        const stderr = await stderrPromise;
        const exitCode = await proc.exited;
        const noticeLine = notice ? `\n${notice}` : "";
        return {
          content: `${stdout}\n[exit: ${exitCode}]${stderr ? `\n${stderr}` : ""}${noticeLine}`,
          isError: exitCode !== 0,
        };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
