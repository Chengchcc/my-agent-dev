import type { Tool } from "@my-agent-team/core";

const descriptionParam = {
  type: "string" as const,
  description:
    "Must be the first parameter. A short human-readable summary explaining why this command is being run.",
};

export const bashTool: Tool = {
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
        description: "Working directory for the command (optional)",
      },
    },
    required: ["command"],
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
    const clamped = Math.min(Math.max(timeout, 1), 600_000);

    // setsid → new session + process group, so timeout can kill all descendants.
    // Fall back to plain bash when setsid is not available (it's not POSIX).
    const hasSetsid = Bun.which("setsid") !== null;
    const proc = Bun.spawn(
      hasSetsid ? ["setsid", "bash", "-c", command] : ["bash", "-c", command],
      {
        stdout: "pipe",
        stderr: "pipe",
        cwd,
      },
    );
    const timer = setTimeout(() => {
      proc.kill();
      // Kill the entire process group to catch orphaned children
      try {
        process.kill(-proc.pid, "SIGTERM");
      } catch {
        /* already dead */
      }
    }, clamped);

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
        new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
        proc.exited,
      ]);

      const code = exitCode === null ? "killed" : exitCode;
      const body = `exit=${code}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`;
      if (exitCode === 0) {
        return { content: body };
      }
      return { content: body, isError: true };
    } finally {
      clearTimeout(timer);
    }
  },
};
