/** OmpBackend: one execute() = one spawned `omp -p --mode json` child = one
 *  Run = one outcome, then the child exits. Context continuation is the
 *  omp session file (ADR 0002 dual truth): the adapter pins a deterministic
 *  session path per branch and resumes it on later runs. There is no
 *  mid-turn steer — omp has no stdin protocol — so steer() rejects
 *  explicitly and the Product layer queues the input as a follow-up turn.
 *
 *  Wire format: omp 17.2.15 `--mode json` stdout lines (see wire.ts),
 *  captured in docs/architecture/execution/backend-kinds-gate0.md. */

import type {
  AgentBackend,
  BackendEvent,
  BackendInputMessage,
  BackendRunInput,
  BackendRunOutcome,
  BackendRunSegment,
} from "@chengchenccc/agent-backend";
import { guardedConsume } from "@chengchenccc/agent-backend";
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
   *  child, like OMA_BIN's env merge). */
  env?: Readonly<Record<string, string | undefined>>;
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

export class OmpBackend implements AgentBackend<"omp"> {
  readonly kind = "omp" as const;
  private readonly executable: string;
  private readonly extraArgs: readonly string[];
  private readonly extraEnv: Readonly<Record<string, string | undefined>> | undefined;
  private readonly abortGraceMs: number;
  private readonly active = new Map<string, ActiveRun>();
  private disposed = false;

  constructor(opts: OmpBackendOptions = {}) {
    this.executable = opts.executable ?? "omp";
    this.extraArgs = opts.args ?? [];
    this.extraEnv = opts.env;
    this.abortGraceMs = opts.abortGraceMs ?? 3_000;
  }

  async execute(input: BackendRunInput<"omp">): Promise<BackendRunSegment<"omp">> {
    const runId = input.run.runId;
    if (this.disposed) throw new OmpBackendError("conflict", "backend is shutting down");
    if (this.active.has(runId)) {
      throw new OmpBackendError("conflict", `runId ${runId} already has a live child process`);
    }

    const workspace = input.workspace.root;
    // The CLI owns its session (native storage); the product forwards the
    // branch's opaque reference only (ADR 0003 decision 6).
    const resumeRef = input.run.cliSessionRef;

    const args = this.buildArgs(input, resumeRef);
    let proc: SpawnedOmpProcess;
    try {
      const runEnv = input.productToolsToken
        ? { ...this.extraEnv, PRODUCT_TOOLS_RUN_TOKEN: input.productToolsToken }
        : this.extraEnv;
      proc = spawnOmpProcess(
        { executable: this.executable, args: [...this.extraArgs, ...args], env: runEnv },
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
    void this.consumeStdout(handle, resumeRef);
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

  private buildArgs(input: BackendRunInput<"omp">, resumeRef: string | undefined): string[] {
    const args = ["-p", "--mode", "json"];
    // Resume by the product-stored reference (session id from a previous
    // run's `session` event); no ref = fresh native session.
    if (resumeRef) args.push("-r", resumeRef);
    const modelId = input.run.model.modelId;
    if (modelId) args.push("--model", modelId);
    args.push("--tools", "read,bash,edit,write,grep,glob");
    // Canonical reasoning_effort (agent.yml) → omp --thinking level.
    // none = explicitly off (never the CLI default); max passes through
    // (omp natively accepts max, live-verified).
    if (input.run.model.reasoningEffort) {
      const level =
        input.run.model.reasoningEffort === "none" ? "off" : input.run.model.reasoningEffort;
      args.push("--thinking", level);
    }
    if (input.run.systemPrompt) args.push("--append-system-prompt", input.run.systemPrompt);
    args.push(this.buildPrompt(input));
    return args;
  }

  /** The driving input message. The first-turn history bridge (ADR 0003
   *  decision 6) is already flat text inside the message, rendered by the
   *  Backend when the branch has no CLI session reference yet — the CLI
   *  session is the runtime truth from the second turn on. */
  private buildPrompt(input: BackendRunInput<"omp">): string {
    return input.input.message.text ?? "";
  }
  /** Single stdout parse loop. The terminal outcome is decided ONLY here
   *  (exit code + error event) — the outcome is the sole terminal authority
   *  (ADR 0017). */
  private async consumeStdout(handle: ActiveRun, resumeRef: string | undefined): Promise<void> {
    await guardedConsume(
      () => this.consumeBody(handle, resumeRef),
      (message) => {
        handle.settle({ status: "failed", error: `stdout consume failed: ${message}` });
        this.active.delete(handle.runId);
      },
    );
  }

  private async consumeBody(handle: ActiveRun, resumeRef: string | undefined): Promise<void> {
    const acc = createOmpAccumulator();
    for await (const line of handle.proc.stdout) {
      if (line.trim() === "") continue;
      const evt = parseOmpLine(line);
      if (!evt) continue;
      mapOmpEvent(acc, evt);
      for (const e of acc.events.splice(0)) handle.pushEvent(e);
    }
    const exitCode = await handle.proc.exit.catch(() => null);
    // The native session id (when the CLI reported one) is the reference
    // the product stores; fall back to the resumed ref.
    const sessionRef = acc.sessionId ?? resumeRef ?? undefined;

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
        ...(sessionRef ? { cliSessionRef: sessionRef } : {}),
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
