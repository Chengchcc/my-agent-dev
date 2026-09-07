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

export function createBashTool(opts: {
  workspaceRoot: string;
  /** Launch strategy; default Null = current unconstrained behavior. */
  sandbox?: BashSandbox;
}): Tool {
  const sandbox = new WorkspaceSandbox(opts.workspaceRoot);
  const launcher = opts.sandbox ?? new NullBashSandbox(opts.workspaceRoot);

  return {
    name: "bash",
    description:
      "Execute a bash shell command. Returns exit code, stdout, and stderr. Default timeout 30s, max 600s.",
    inputSchema: {
      type: "object",
      properties: {
        description: descriptionParam,
        command: {
          type: "string",
          description: "The shell command to execute",
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
      } = input as {
        command: string;
        timeout?: number;
        cwd?: string;
      };

      // Validate cwd against the fixed workspace sandbox. Out-of-bounds cwd
      // is a tool error, never a silent fallback to process cwd.
      let validatedCwd = opts.workspaceRoot;
      if (cwd) {
        try {
          validatedCwd = sandbox.validateCwd(cwd);
        } catch {
          return {
            content: `Error: cwd escapes workspace root: ${String(cwd)}`,
            isError: true,
          };
        }
      }

      const upper = maxToolTimeoutMs();
      const cap = upper > 0 ? Math.min(upper, 600_000) : 600_000;
      const clamped = Math.min(Math.max(timeout, 1), cap);
      // Strip credential-shaped vars from the inherited env: the bash child
      // needs tooling (PATH/HOME/LANG/TZ), not provider keys or the per-run
      // product-tools token. Full inheritance let one `env`/`printenv` read
      // every secret the oma process holds, voiding the childEnv allowlist
      // and stderr redaction above it.
      const BASH_ENV_DENY = /API_KEY|AUTH_TOKEN|_TOKEN$|_SECRET$|PASSWORD|PASSWD/;
      const bashEnv = Object.fromEntries(
        Object.entries(childEnv()).filter(([k]) => !BASH_ENV_DENY.test(k)),
      );
      const proc = launcher.spawn(command, { cwd: validatedCwd, env: bashEnv });

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
        return {
          content: `${stdout}\n[exit: ${exitCode}]${stderr ? `\n${stderr}` : ""}`,
          isError: exitCode !== 0,
        };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
