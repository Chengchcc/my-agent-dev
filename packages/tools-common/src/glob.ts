import type { Tool } from "@my-agent-team/core";
import { WorkspaceSandbox } from "./workspace-sandbox.js";

const descriptionParam = {
  type: "string" as const,
  description:
    "Must be the first parameter. A short human-readable summary explaining why this search is being performed.",
};

export function createGlobTool(opts: { workspaceRoot: string }): Tool {
  const sandbox = new WorkspaceSandbox(opts.workspaceRoot);

  return {
    name: "glob",
    description:
      "Find files matching a glob pattern. Returns newline-separated paths. Results are capped at 500.",
    inputSchema: {
      type: "object",
      properties: {
        description: descriptionParam,
        pattern: { type: "string", description: "The glob pattern to match (e.g. '**/*.ts')" },
        cwd: {
          type: "string",
          description: "Subdirectory to search from (relative to workspace root)",
        },
      },
      required: ["pattern"],
    },
    async execute(input) {
      const { pattern, cwd } = input as { pattern: string; cwd?: string };
      const validatedCwd = cwd
        ? (() => {
            try {
              return sandbox.validateCwd(cwd);
            } catch {
              return opts.workspaceRoot;
            }
          })()
        : opts.workspaceRoot;

      const LIMIT = 500;
      const glob = new Bun.Glob(pattern);
      const matches: string[] = [];
      let truncated = false;
      for await (const m of glob.scan({ cwd: validatedCwd, absolute: false, onlyFiles: true })) {
        if (matches.length >= LIMIT) {
          truncated = true;
          break;
        }
        matches.push(m);
      }

      if (matches.length === 0) return { content: "(no matches)" };
      const body = matches.join("\n");
      return { content: truncated ? `${body}\n... (truncated at ${LIMIT})` : body };
    },
  };
}

export const globTool: Tool = createGlobTool({ workspaceRoot: process.cwd() });
