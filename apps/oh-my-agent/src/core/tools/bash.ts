import type { Tool } from "@chengchenccc/message";
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

export function createBashTool(opts: { workspaceRoot: string }): Tool {
  const sandbox = new WorkspaceSandbox(opts.workspaceRoot);

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
      const hasSetsid = Bun.which("setsid") !== null;
      const proc = Bun.spawn(
        hasSetsid ? ["setsid", "bash", "-c", command] : ["bash", "-c", command],
        { stdout: "pipe", stderr: "pipe", cwd: validatedCwd },
      );

      // Kill the process group on timeout OR abort signal.
      const killGroup = () => {
        proc.kill();
        try {
          process.kill(-proc.pid!, "SIGKILL");
        } catch {
          /* */
        }
      };
      const timer = setTimeout(killGroup, clamped);
      const onAbort = () => killGroup();
      if (signal?.aborted) killGroup();
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        const stderrPromise = new Response(proc.stderr).text();
        let stdout = "";
        if (options?.onOutput) {
          const reader = proc.stdout.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = new TextDecoder().decode(value);
            stdout += chunk;
            options.onOutput(chunk);
          }
        } else {
          stdout = await new Response(proc.stdout).text();
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
