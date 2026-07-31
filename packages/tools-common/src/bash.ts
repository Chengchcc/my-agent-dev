import type { Tool } from "@my-agent-team/core";
import { WorkspaceSandbox } from "./workspace-sandbox.js";

const descriptionParam = {
  type: "string" as const,
  description:
    "Must be the first parameter. A short human-readable summary explaining why this command is being run.",
};

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
    async execute(input) {
      const {
        command,
        timeout = 30_000,
        cwd,
      } = input as {
        command: string;
        timeout?: number;
        cwd?: string;
      };

      // Validate cwd against the fixed workspace sandbox
      const validatedCwd = cwd
        ? (() => {
            try {
              return sandbox.validateCwd(cwd);
            } catch {
              return undefined;
            }
          })()
        : opts.workspaceRoot;

      const clamped = Math.min(Math.max(timeout, 1), 600_000);
      const hasSetsid = Bun.which("setsid") !== null;
      const proc = Bun.spawn(
        hasSetsid ? ["setsid", "bash", "-c", command] : ["bash", "-c", command],
        { stdout: "pipe", stderr: "pipe", cwd: validatedCwd },
      );

      const timer = setTimeout(() => {
        proc.kill();
        try {
          process.kill(-proc.pid!, "SIGKILL");
        } catch {
          /* */
        }
      }, clamped);

      try {
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        const exitCode = await proc.exited;
        return {
          content: `${stdout}\n[exit: ${exitCode}]${stderr ? `\n${stderr}` : ""}`,
          isError: exitCode !== 0,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
