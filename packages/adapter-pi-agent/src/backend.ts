/** PiBackend: one execute() = one spawned `pi -p --mode json` child = one
 *  Run = one outcome, then the child exits (solo pi.go shape). Context
 *  continuation (ADR 0002 dual truth): the branch-pinned session file is
 *  passed via `--session <path>` — pi writes a fresh file when absent and
 *  RESUMES an existing one (session-manager.ts preserves the explicit
 *  path). No mid-turn steer — steer() rejects explicitly.
 *
 *  Wire format: pi's extension event taxonomy (message_update /
 *  tool_execution_start|end / turn_end / agent_end), from
 *  /root/pi/packages/coding-agent/src/core/agent-session.ts.
 *  NOT yet verified against a real pi CLI (not installed locally —
 *  Gate 0 record). */

import type {
  AgentBackend,
  BackendEvent,
  BackendInputMessage,
  BackendRunInput,
  BackendRunOutcome,
  BackendRunSegment,
} from "@my-agent-team/agent-backend";
import { buildOutcomeMessages, createPiAccumulator, mapPiEvent } from "./event-mapper.js";
import { type SpawnedPiProcess, spawnPiProcess } from "./process.js";
import { parsePiLine } from "./wire.js";

export type PiBackendErrorCode = "spawn_failed" | "conflict" | "not_found";

export class PiBackendError extends Error {
  constructor(
    readonly code: PiBackendErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface PiBackendOptions {
  /** pi executable (default "pi"; tests point at a fake-CLI script). */
  executable?: string;
  /** Extra argv prepended to the built args (test injection). */
  args?: readonly string[];
  /** Extra env applied over the parent process env. */
  env?: Readonly<Record<string, string | undefined>>;
  /** pi-mcp-adapter extension path (`pi install npm:pi-mcp-adapter`
   *  registers it; an explicit -e path overrides for per-run spawns). */
  mcpAdapterPath?: string;
  /** Product Tools MCP bearer token for the workspace mcp.json. */
  productToolsToken?: string;
  abortGraceMs?: number;
}

interface ActiveRun {
  readonly runId: string;
  readonly proc: SpawnedPiProcess;
  readonly settle: (outcome: BackendRunOutcome) => void;
  readonly outcome: Promise<BackendRunOutcome>;
  stopRequested: boolean;
  pushEvent(event: BackendEvent<"pi">): void;
  readonly events: AsyncIterable<BackendEvent<"pi">>;
}

export class PiBackend implements AgentBackend<"pi"> {
  readonly kind = "pi" as const;
  private readonly executable: string;
  private readonly extraArgs: readonly string[];
  private readonly extraEnv: Readonly<Record<string, string | undefined>> | undefined;
  private readonly mcpAdapterPath: string | undefined;
  private readonly productToolsToken: string | undefined;
  private readonly abortGraceMs: number;
  private readonly active = new Map<string, ActiveRun>();
  private disposed = false;

  constructor(opts: PiBackendOptions = {}) {
    this.executable = opts.executable ?? "pi";
    this.extraArgs = opts.args ?? [];
    this.extraEnv = opts.env;
    this.mcpAdapterPath = opts.mcpAdapterPath;
    this.productToolsToken = opts.productToolsToken;
    this.abortGraceMs = opts.abortGraceMs ?? 3_000;
  }

  async execute(input: BackendRunInput<"pi">): Promise<BackendRunSegment<"pi">> {
    const runId = input.run.runId;
    if (this.disposed) throw new PiBackendError("conflict", "backend is shutting down");
    if (this.active.has(runId)) {
      throw new PiBackendError("conflict", `runId ${runId} already has a live child process`);
    }

    const workspace = input.workspace.root;
    // The CLI owns its session (native storage); the product forwards the
    // branch's opaque reference only (ADR 0003 decision 6).
    const resumeRef = input.run.cliSessionRef;

    const args = this.buildArgs(input, resumeRef);
    let proc: SpawnedPiProcess;
    try {
      proc = spawnPiProcess(
        { executable: this.executable, args: [...this.extraArgs, ...args], env: this.extraEnv },
        { cwd: workspace },
      );
    } catch (err) {
      throw new PiBackendError(
        "spawn_failed",
        `pi spawn failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const handle = createActiveRun(runId, proc);
    this.active.set(runId, handle);
    void this.consumeStdout(handle, resumeRef);
    return {
      events: handle.events,
      outcome: handle.outcome,
      stop: () => this.stop(runId),
    };
  }

  /** Per-turn short process: a steer cannot reach a live run. Explicit
   *  rejection — the Product layer cancels the steer input. */
  async steer(_runId: string, _input: BackendInputMessage): Promise<void> {
    throw new PiBackendError(
      "not_found",
      "pi backend runs one short-lived process per turn; steer is unsupported — queue the input as a follow-up turn",
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

  private buildArgs(input: BackendRunInput<"pi">, resumeRef: string | undefined): string[] {
    const args = ["-p", "--mode", "json"];
    // pi's --session accepts an id (or file path) and resumes when found.
    if (resumeRef) args.push("--session", resumeRef);
    const modelId = input.run.model.modelId;
    if (modelId) {
      // Canonical `<provider>/<model>` id splits into pi's two flags.
      const slash = modelId.indexOf("/");
      if (slash > 0) {
        args.push("--provider", modelId.slice(0, slash));
        args.push("--model", modelId.slice(slash + 1));
      } else {
        args.push("--model", modelId);
      }
    }
    args.push("--tools", "read,bash,edit,write,grep,find,ls");
    if (input.run.systemPrompt) args.push("--append-system-prompt", input.run.systemPrompt);
    if (this.mcpAdapterPath) args.push("--extension", this.mcpAdapterPath);
    args.push(this.buildPrompt(input));
    return args;
  }

  /** The driving input message. The first-turn history bridge (ADR 0003
   *  decision 6) is already flat text inside the message, rendered by the
   *  Backend when the branch has no pi session reference yet — the pi
   *  session is the runtime truth from the second turn on. */
  private buildPrompt(input: BackendRunInput<"pi">): string {
    return input.input.message.text ?? "";
  }

  /** Single stdout parse loop. The terminal outcome is decided ONLY here
   *  (exit code + error event). */
  private async consumeStdout(handle: ActiveRun, resumeRef: string | undefined): Promise<void> {
    const acc = createPiAccumulator();
    for await (const line of handle.proc.stdout) {
      if (line.trim() === "") continue;
      const evt = parsePiLine(line);
      if (!evt) continue;
      mapPiEvent(acc, evt);
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
        error: `pi exited with code ${exitCode}${tail}`,
        usage: acc.usage,
      });
    } else {
      handle.settle({
        status: "completed",
        messages: buildOutcomeMessages(acc.assistantTexts),
        usage: acc.usage,
        ...((acc.sessionId ?? resumeRef) ? { cliSessionRef: acc.sessionId ?? resumeRef } : {}),
      });
    }
    this.active.delete(handle.runId);
  }
}

function createActiveRun(runId: string, proc: SpawnedPiProcess): ActiveRun {
  let settled = false;
  let settleOutcome: ((o: BackendRunOutcome) => void) | null = null;
  const queue: BackendEvent<"pi">[] = [];
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
