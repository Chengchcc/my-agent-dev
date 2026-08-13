/** OmpBackend: one execute() = one spawned `omp -p --mode json` child = one
 *  Run = one outcome, then the child exits. Context continuation is the
 *  omp session file (ADR 0002 dual truth): the adapter pins a deterministic
 *  session path per branch and resumes it on later runs. There is no
 *  mid-turn steer — omp has no stdin protocol — so steer() rejects
 *  explicitly and the Product layer queues the input as a follow-up turn.
 *
 *  Wire format: omp 17.2.15 `--mode json` stdout lines (see wire.ts),
 *  captured in docs/architecture/execution/backend-kinds-gate0.md. */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  AgentBackend,
  BackendEvent,
  BackendInputMessage,
  BackendRunInput,
  BackendRunOutcome,
  BackendRunSegment,
} from "@my-agent-team/agent-backend";
import { buildOutcomeMessages, createOmpAccumulator, mapOmpEvent } from "./event-mapper.js";
import { type SpawnedOmpProcess, spawnOmpProcess } from "./process.js";
import { parseOmpLine } from "./wire.js";

export type OmpBackendErrorCode = "spawn_failed" | "conflict" | "not_found";

export class OmpBackendError extends Error {
  constructor(
    readonly code: OmpBackendErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface OmpBackendOptions {
  /** omp executable (default "omp"; tests point at a fake-CLI script). */
  executable?: string;
  /** Extra argv prepended to the built args (test injection: fake-CLI
   *  entry path). */
  args?: readonly string[];
  /** Extra env applied over the parent process env (inherited by the
   *  child, like CODING_AGENT_BIN's env merge). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Product Tools MCP bearer token for the workspace mcp.json (D3:
   *  claude/pi/omp run with product tools mounted when available). */
  productToolsToken?: string;
  abortGraceMs?: number;
}

interface ActiveRun {
  readonly runId: string;
  readonly proc: SpawnedOmpProcess;
  /** Exactly-once terminal settle (outcome authority). */
  readonly settle: (outcome: BackendRunOutcome) => void;
  readonly outcome: Promise<BackendRunOutcome>;
  /** True once stop() requested cancellation. */
  stopRequested: boolean;
  // Push event stream (queue + waiters).
  pushEvent(event: BackendEvent<"omp">): void;
  readonly events: AsyncIterable<BackendEvent<"omp">>;
}

const SESSION_REL = join(".omp", "session");

export class OmpBackend implements AgentBackend<"omp"> {
  readonly kind = "omp" as const;
  private readonly executable: string;
  private readonly extraArgs: readonly string[];
  private readonly extraEnv: Readonly<Record<string, string | undefined>> | undefined;
  private readonly productToolsToken: string | undefined;
  private readonly abortGraceMs: number;
  private readonly active = new Map<string, ActiveRun>();
  private disposed = false;

  constructor(opts: OmpBackendOptions = {}) {
    this.executable = opts.executable ?? "omp";
    this.extraArgs = opts.args ?? [];
    this.extraEnv = opts.env;
    this.productToolsToken = opts.productToolsToken;
    this.abortGraceMs = opts.abortGraceMs ?? 3_000;
  }

  async execute(input: BackendRunInput<"omp">): Promise<BackendRunSegment<"omp">> {
    const runId = input.run.runId;
    if (this.disposed) throw new OmpBackendError("conflict", "backend is shutting down");
    if (this.active.has(runId)) {
      throw new OmpBackendError("conflict", `runId ${runId} already has a live child process`);
    }

    const workspace = input.workspace.root;
    const sessionPath = join(workspace, SESSION_REL, `${input.metadata.branchId}.jsonl`);
    const resume = existsSync(sessionPath);
    if (!resume) mkdirSync(dirname(sessionPath), { recursive: true });

    this.writeMcpConfig(input, workspace);

    const args = this.buildArgs(input, sessionPath, resume);
    let proc: SpawnedOmpProcess;
    try {
      proc = spawnOmpProcess(
        { executable: this.executable, args: [...this.extraArgs, ...args], env: this.extraEnv },
        { cwd: workspace },
      );
    } catch (err) {
      throw new OmpBackendError(
        "spawn_failed",
        `omp spawn failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const handle = createActiveRun(runId, proc);
    this.active.set(runId, handle);
    void this.consumeStdout(handle, sessionPath);
    return {
      events: handle.events,
      outcome: handle.outcome,
      stop: () => this.stop(runId),
    };
  }

  /** Per-turn short process: a steer cannot reach a live run. Explicit
   *  rejection — the Product layer cancels the steer input (never silently
   *  converted into a normal input). */
  async steer(_runId: string, _input: BackendInputMessage): Promise<void> {
    throw new OmpBackendError(
      "not_found",
      "omp backend runs one short-lived process per turn; steer is unsupported — queue the input as a follow-up turn",
    );
  }

  async stop(runId: string): Promise<void> {
    const handle = this.active.get(runId);
    if (!handle) return;
    handle.stopRequested = true;
    handle.proc.kill("SIGTERM");
    const exited = await withTimeout(handle.proc.exit, this.abortGraceMs);
    if (exited === null) {
      handle.proc.kill("SIGKILL");
      await handle.proc.exit.catch(() => null);
    }
    handle.settle({
      status: "aborted",
      error: "stopped by product backend",
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const handles = [...this.active.values()];
    for (const h of handles) {
      h.stopRequested = true;
      h.proc.kill("SIGTERM");
    }
    await Promise.allSettled(
      handles.map(async (h) => {
        const exited = await withTimeout(h.proc.exit, this.abortGraceMs);
        if (exited === null) {
          h.proc.kill("SIGKILL");
          await h.proc.exit.catch(() => null);
        }
        h.settle({ status: "aborted", error: "backend disposed" });
      }),
    );
    this.active.clear();
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private buildArgs(input: BackendRunInput<"omp">, sessionPath: string, resume: boolean): string[] {
    const args = ["-p", "--mode", "json"];
    if (resume) {
      args.push("-r", sessionPath);
    } else {
      args.push("--session", sessionPath);
    }
    const modelId = input.run.model.modelId;
    if (modelId) args.push("--model", modelId);
    args.push("--tools", "read,bash,edit,write,grep,glob");
    if (input.run.systemPrompt) args.push("--append-system-prompt", input.run.systemPrompt);
    args.push(this.buildPrompt(input, resume));
    return args;
  }

  /** The driving input message. When the branch has no omp session yet
   *  (fresh branch / first run after a kind switch), the projected product
   *  history is rendered as flat text so the model is not amnesiac — the
   *  CLI session becomes the runtime truth from the second turn on
   *  (ponytail: first-turn-only bridge; flat text loses tool structure). */
  private buildPrompt(input: BackendRunInput<"omp">, resume: boolean): string {
    const inputText = input.input.message.text ?? "";
    if (resume || input.history.length === 0) return inputText;
    const historyText = input.history
      .map((h) => {
        const who = h.message.role === "user" ? "User" : "Assistant";
        return `${who}: ${h.message.text}`;
      })
      .join("\n\n");
    return `${historyText}\n\n${inputText}`;
  }

  /** Product Tools mounting (D3 全量对齐): write the standard `.mcp.json`
   *  into the workspace root; omp loads it at project level. Skipped when
   *  the entrypoint is not a real SSE url (unconfigured deployment) or no
   *  token is available. */
  private writeMcpConfig(input: BackendRunInput<"omp">, workspace: string): void {
    const entrypoint = input.run.productTools[0]?.entrypoint ?? "";
    if (!entrypoint.startsWith("sse:")) return;
    const url = entrypoint.slice(4);
    const headers =
      this.productToolsToken !== undefined
        ? { Authorization: `Bearer ${this.productToolsToken}` }
        : undefined;
    writeFileSync(
      join(workspace, ".mcp.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: {
          "product-tools": { type: "sse", url, ...(headers ? { headers } : {}) },
        },
      }),
    );
  }

  /** Single stdout parse loop. The terminal outcome is decided ONLY here
   *  (exit code + error event) — the outcome is the sole terminal authority
   *  (ADR 0017). */
  private async consumeStdout(handle: ActiveRun, sessionPath: string): Promise<void> {
    const acc = createOmpAccumulator();
    for await (const line of handle.proc.stdout) {
      if (line.trim() === "") continue;
      const evt = parseOmpLine(line);
      if (!evt) continue;
      mapOmpEvent(acc, evt);
      for (const e of acc.events.splice(0)) handle.pushEvent(e);
    }
    const exitCode = await handle.proc.exit.catch(() => null);

    if (handle.stopRequested) {
      // stop() already settled aborted (exactly-once guard below).
    } else if (acc.error) {
      handle.settle({ status: "failed", error: acc.error, usage: acc.usage });
    } else if (exitCode !== 0) {
      const tail = handle.proc.stderrTail ? ` (stderr: ${handle.proc.stderrTail})` : "";
      handle.settle({
        status: "failed",
        error: `omp exited with code ${exitCode}${tail}`,
        usage: acc.usage,
      });
    } else {
      handle.settle({
        status: "completed",
        messages: buildOutcomeMessages(acc.assistantTexts),
        usage: acc.usage,
        // The branch-pinned session file is the CLI-side runtime truth
        // (ADR 0002); the Product Backend records it on the branch.
        cliSessionRef: sessionPath,
      });
    }
    this.active.delete(handle.runId);
  }
}

function createActiveRun(runId: string, proc: SpawnedOmpProcess): ActiveRun {
  let settled = false;
  let settleOutcome: ((o: BackendRunOutcome) => void) | null = null;
  const queue: BackendEvent<"omp">[] = [];
  const waiters: Array<() => void> = [];
  let eventsClosed = false;

  const outcome = new Promise<BackendRunOutcome>((resolve) => {
    settleOutcome = resolve;
  });

  const handle: ActiveRun = {
    runId,
    proc,
    stopRequested: false,
    settle(o) {
      if (settled) return;
      settled = true;
      eventsClosed = true;
      settleOutcome?.(o);
      for (const w of waiters.splice(0)) w();
    },
    outcome,
    pushEvent(event) {
      if (eventsClosed) return;
      queue.push(event);
      for (const w of waiters.splice(0)) w();
    },
    events: (async function* () {
      while (!eventsClosed || queue.length > 0) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (eventsClosed) return;
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    })(),
  };
  return handle;
}

/** Race a promise against a timeout; the timer is cleared so a settled race
 *  never holds the event loop. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}
