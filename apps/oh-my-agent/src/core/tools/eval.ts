import type { Tool } from "@chengchenccc/message";
import { runInSandbox } from "@chengchenccc/sandbox";

const descriptionParam = {
  type: "string" as const,
  description:
    "Must be the first parameter. A short human-readable summary explaining what this code evaluates.",
};

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** eval: run a TS/JS snippet in a process sandbox (spawned bun subprocess,
 *  minimal env, hard timeout). The snippet must `export default (ctx) => out`
 *  where ctx is the JSON `input` object. Output is the returned value; stdout
 *  and stderr are reported alongside. Files written next to the script live
 *  only for the run unless keepWorkspace is set (cwd = workspace eval dir). */
export function createEvalTool(_opts: { workspaceRoot: string }): Tool {
  return {
    name: "eval",
    description:
      "Evaluate a TypeScript/JavaScript snippet in an isolated sandbox process. The code must `export default async (ctx) => result` — ctx is the provided input object and result must be JSON-serializable. Use for computations, data shaping, and quick experiments instead of bash one-liners.",
    inputSchema: {
      type: "object",
      properties: {
        description: descriptionParam,
        code: {
          type: "string",
          description: "TS/JS module source. Must `export default async (ctx) => result`.",
        },
        input: {
          type: "object",
          description: "JSON object passed to the snippet as ctx",
          additionalProperties: true,
        },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds (default 30000)",
        },
        keepWorkspace: {
          type: "boolean",
          description: "Keep the sandbox working dir across this session (default false)",
        },
      },
      required: ["description", "code"],
    },
    async execute(input: Record<string, unknown>, signal?: AbortSignal) {
      const {
        code,
        input: ctxInput,
        timeout = envMs("OMA_EVAL_TIMEOUT_MS", 30_000),
        keepWorkspace = false,
      } = input as {
        code: string;
        input?: Record<string, unknown>;
        timeout?: number;
        keepWorkspace?: boolean;
      };
      if (typeof code !== "string" || code.trim() === "") {
        return { content: "eval requires non-empty code", isError: true };
      }
      if (signal?.aborted) return { content: "aborted", isError: true };
      try {
        const r = await runInSandbox({
          code,
          input: ctxInput ?? {},
          timeoutMs: timeout,
          keepCwd: keepWorkspace,
        });
        const parts: string[] = [];
        if (r.output !== null) parts.push(JSON.stringify(r.output, null, 2));
        if (r.stdout.trim()) parts.push(`stdout:\n${r.stdout.trim()}`);
        if (r.stderr.trim()) parts.push(`stderr:\n${r.stderr.trim()}`);
        const ok = r.exitCode === 0;
        return {
          content: ok
            ? parts.join("\n\n") || "(no output)"
            : `eval failed (exit ${r.exitCode}):\n${parts.join("\n\n")}`,
          isError: !ok,
        };
      } catch (err) {
        return {
          content: `eval error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}
