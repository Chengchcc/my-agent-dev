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

// ─── Background jobs (M-eval) ──────────────────────────────────────────

interface EvalJob {
  id: string;
  code: string;
  startedAt: number;
  finishedAt: number | null;
  content: string;
  isError: boolean;
  killed: boolean;
  controller: AbortController;
  promise: Promise<void>;
}

// Module-scope registry (see bash.ts): session-wide for the TUI,
// per-process for the backend.
interface EvalJob {
  id: string;
  code: string;
  startedAt: number;
  finishedAt: number | null;
  content: string;
  isError: boolean;
  killed: boolean;
  controller: AbortController;
  promise: Promise<void>;
}
const jobs = new Map<string, EvalJob>();
let nextJobSeq = 1;
const MAX_JOBS = 32;

/** Running background eval jobs — surfaced by the TUI status bar. */
export function countRunningEvalJobs(): number {
  let running = 0;
  for (const j of jobs.values()) if (j.finishedAt === null) running++;
  return running;
}

/** eval: run a TS/JS snippet in a process sandbox (spawned bun subprocess,
 *  minimal env, hard timeout). The snippet must `export default (ctx) => out`
 *  where ctx is the JSON `input` object. Output is the returned value; stdout
 *  and stderr are reported alongside. Files written next to the script live
 *  only for the run unless keepWorkspace is set (cwd = workspace eval dir). */
export function createEvalTool(_opts: { workspaceRoot: string }): Tool {
  function jobSummary(job: EvalJob): string {
    const state = job.finishedAt === null ? "running" : "completed";
    const secs = Math.round(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000);
    const flag = job.killed ? ", killed" : "";
    return `job ${job.id} [${state}${flag}] ${secs}s\ncommand: ${job.code}\n${job.content}`;
  }

  return {
    name: "eval",
    description:
      "Evaluate a TypeScript/JavaScript snippet in an isolated sandbox process. The code must `export default async (ctx) => result` — ctx is the provided input object and result must be JSON-serializable. Use for computations, data shaping, and quick experiments instead of bash one-liners. " +
      "Supports background execution (async) with polling via jobAction.",
    inputSchema: {
      type: "object",
      properties: {
        description: descriptionParam,
        code: {
          type: "string",
          description:
            "TS/JS module source. Must `export default async (ctx) => result`. Omit when jobAction is set.",
        },
        input: {
          type: "object",
          description: "JSON object passed to the snippet as ctx",
          additionalProperties: true,
        },
        async: {
          type: "boolean",
          description:
            "Run in the background: returns a job id immediately. Poll with jobAction=output; " +
            "the job keeps running until its timeout.",
        },
        jobAction: {
          type: "string",
          enum: ["list", "output", "kill"],
          description:
            "Manage background eval jobs: list all, get one job's result (needs jobId), or kill it (needs jobId).",
        },
        jobId: {
          type: "string",
          description: "Background job id (eval_N) for jobAction=output/kill",
        },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds (default 30000). 0 disables the deadline.",
        },
        keepWorkspace: {
          type: "boolean",
          description: "Keep the sandbox working dir across this session (default false)",
        },
      },
      required: ["description"],
    },
    async execute(input: Record<string, unknown>, signal?: AbortSignal) {
      const {
        code,
        input: ctxInput,
        timeout = envMs("OMA_EVAL_TIMEOUT_MS", 30_000),
        keepWorkspace = false,
        pty: _pty,
        jobAction,
        jobId,
      } = input as {
        code: string;
        input?: Record<string, unknown>;
        timeout?: number;
        keepWorkspace?: boolean;
        pty?: boolean;
        jobAction?: "list" | "output" | "kill";
        jobId?: string;
      };

      // Background job management (M-eval): polling surface for jobs the
      // model started with async=true.
      if (jobAction) {
        if (jobAction === "list") {
          if (jobs.size === 0) return { content: "(no background jobs)" };
          const rows = [...jobs.values()].map((j) => {
            const state = j.finishedAt === null ? "running" : "completed";
            return `${j.id} [${state}] ${j.code}`;
          });
          return { content: rows.join("\n") };
        }
        const target = jobId ? jobs.get(jobId) : undefined;
        if (!target) return { content: `Error: unknown job: ${jobId ?? "(none)"}`, isError: true };
        if (jobAction === "kill") {
          if (target.finishedAt === null) {
            target.killed = true;
            target.controller.abort();
          }
          return { content: `Killed ${target.id}` };
        }
        return {
          content: jobSummary(target),
          isError: target.isError && target.finishedAt !== null,
        };
      }
      if (typeof code !== "string" || code.trim() === "") {
        return { content: "eval requires non-empty code", isError: true };
      }

      // pi semantics: timeout 0 disables the deadline entirely (long
      // parses/compiles). Otherwise model-controlled values stay clamped —
      // an unbounded timeout parks a sandbox slot indefinitely.
      const requested = Number(timeout);
      const clampedTimeout =
        requested === 0 ? 0 : Math.min(Math.max(requested || 30_000, 1_000), 600_000);

      const runCell = async (
        runnerSignal?: AbortSignal,
      ): Promise<{ content: string; isError: boolean }> => {
        try {
          const r = await runInSandbox({
            code,
            input: ctxInput ?? {},
            timeoutMs: clampedTimeout,
            keepCwd: keepWorkspace,
            signal: runnerSignal,
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
      };

      // Background execution (M-eval): return a job id immediately; the
      // model polls via jobAction. The job's own timeout (or none at 0)
      // applies — killing uses the sandbox abort signal.
      if ((input as { async?: boolean }).async === true) {
        if (jobs.size >= 32) {
          return {
            content: `Error: too many background jobs (${jobs.size}/${MAX_JOBS}); collect or kill existing jobs first`,
            isError: true,
          };
        }
        const id = `eval_${nextJobSeq++}`;
        const controller = new AbortController();
        const job: EvalJob = {
          id,
          code,
          startedAt: Date.now(),
          finishedAt: null,
          content: "",
          isError: false,
          killed: false,
          controller,
          promise: Promise.resolve(),
        };
        jobs.set(id, job);
        job.promise = (async () => {
          const done = await runCell(controller.signal);
          job.content = done.content;
          job.isError = done.isError;
          job.finishedAt = Date.now();
        })();
        void job.promise.catch(() => {});
        return {
          content: `Backgrounded as job ${id}; fetch output with eval { "jobAction": "output", "jobId": "${id}" }.`,
        };
      }

      if (signal?.aborted) return { content: "aborted", isError: true };
      return runCell(signal);
    },
  };
}
