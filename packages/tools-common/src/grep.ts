import type { Tool } from "@chengchenccc/core";
import { WorkspaceSandbox } from "./workspace-sandbox.js";

const descriptionParam = {
  type: "string" as const,
  description:
    "Must be the first parameter. A short human-readable summary explaining why this search is being performed.",
};

export function createGrepTool(opts: { workspaceRoot: string }): Tool {
  const sandbox = new WorkspaceSandbox(opts.workspaceRoot);

  return {
    name: "grep",
    description:
      "Search files using ripgrep. Returns matching lines with line numbers. Requires `rg`.",
    inputSchema: {
      type: "object",
      properties: {
        description: descriptionParam,
        pattern: { type: "string", description: "The regex pattern to search for" },
        path: {
          type: "string",
          description: "File or directory to search in (relative to workspace root)",
        },
        glob: { type: "string", description: "Glob pattern to filter files (e.g. '*.ts')" },
      },
      required: ["pattern"],
    },
    async execute(input) {
      const {
        pattern,
        path: searchPath,
        glob,
      } = input as {
        pattern: string;
        path?: string;
        glob?: string;
      };

      let validatedPath = opts.workspaceRoot;
      if (searchPath) {
        try {
          validatedPath = sandbox.validate(searchPath);
        } catch {
          return {
            content: `Error: path escapes workspace root: ${String(searchPath)}`,
            isError: true,
          };
        }
      }

      const args = ["rg", "-n", "--color=never"];
      if (glob) args.push("--glob", glob);
      args.push(pattern, validatedPath);

      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
      } catch {
        return { content: "grep failed: ripgrep not found", isError: true };
      }

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
        new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
        proc.exited,
      ]);

      if (exitCode === 1) return { content: "" };
      if (exitCode >= 2)
        return { content: `grep failed (exit=${exitCode}): ${stderr}`, isError: true };
      return { content: stdout };
    },
  };
}
