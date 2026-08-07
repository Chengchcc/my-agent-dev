import type {
  AgentBackend,
  BackendEvent,
  BackendInputMessage,
  BackendRunInput,
  BackendRunOutcome,
  BackendRunSegment,
  CodingAgentOutput,
  RunEventEnvelope,
} from "@my-agent-team/agent-backend";
import { debugLog } from "@my-agent-team/agent-backend";
import { mapRunEvent, mapRunOutcome } from "./event-mapper.js";
import {
  type CodingAgentCommandConfig,
  type SpawnedCodingAgentProcess,
  spawnCodingAgentProcess,
} from "./process.js";
import { codingAgentOutputSchema } from "./protocol.js";

/** One execute() = one spawned `coding-agent --mode rpc` child = one Run =
 *  one outcome, then the child exits. No polling, no SSE, no reconnect, no
 *  session cache: the child handle IS the run. stdout is consumed by ONE
 *  routing task per handle; command responses are matched by command id. */

export type CodingAgentProcessErrorCode =
  | "spawn_failed"
  | "invalid_request"
  | "conflict"
  | "not_found"
  | "process_failed";

export class CodingAgentProcessError extends Error {
  readonly code: CodingAgentProcessErrorCode;
  constructor(code: CodingAgentProcessErrorCode, message: string) {
    super(message);
    this.name = "CodingAgentProcessError";
    this.code = code;
  }
}

export interface CodingAgentBackendOptions {
  /** Bounded grace for the child to exit after outcome/abort before kill. */
  abortGraceMs?: number;
  /** Max simultaneously LIVE children (spawned Runs). Further executes wait
   *  FIFO for a slot; the input stays undelivered while queued. `stop()`
   *  cancels a queued wait so the Run never spawns. No pool: the limit only
   *  gates spawn. */
  maxConcurrent?: number;
}

interface CommandWaiter {
  resolve(result: { success: boolean; error?: string }): void;
}

interface ActiveHandle {
  readonly runId: string;
  readonly proc: SpawnedCodingAgentProcess;
  readonly executeCommandId: string;
  accepted: boolean;
  /** One-shot acceptance: null = accepted, string = rejection. */
  readonly acceptance: Promise<string | null>;
  settleAcceptance: ((err: string | null) => void) | null;
  /** The child's outcome envelope arrived (terminal authority). */
  outcomeReceived: boolean;
  settled: boolean;
  settle(outcome: BackendRunOutcome): void;
  readonly outcome: Promise<BackendRunOutcome>;
  pushEvent(envelope: RunEventEnvelope): void;
  readonly events: AsyncIterable<BackendEvent<"coding_agent">>;
}

/** Race a promise against a timeout; the timer is cleared so a settled race
 *  never holds the event loop. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const raced = Promise.race([
    promise,
    new Promise<null>((r) => {
      timer = setTimeout(() => r(null), ms);
    }),
  ]);
  void raced.finally(() => {
    if (timer) clearTimeout(timer);
  });
  return raced;
}

export class CodingAgentBackend implements AgentBackend<"coding_agent"> {
  readonly kind = "coding_agent" as const;
  private readonly command: CodingAgentCommandConfig;
  private readonly abortGraceMs: number;
  private readonly maxConcurrent: number;
  private readonly active = new Map<string, ActiveHandle>();
  /** Per-run command response waiters (steer/abort), matched by command id. */
  readonly pendingResponses = new Map<string, Map<string, CommandWaiter>>();
  /** FIFO spawn-slot waiters (runId → release resolver). */
  private readonly slotQueue: Array<{
    runId: string;
    resolve(release: (() => void) | null): void;
  }> = [];
  private liveSlots = 0;
  /** Set by dispose(): rejects new executes and cancels queued spawns. */
  private disposed = false;

  constructor(command: CodingAgentCommandConfig, opts: CodingAgentBackendOptions = {}) {
    this.command = command;
    this.abortGraceMs = opts.abortGraceMs ?? 3_000;
    this.maxConcurrent = opts.maxConcurrent ?? 0; // 0 = unbounded
  }

  /** FIFO spawn-slot acquire. Resolves `null` when the wait was cancelled by
   *  stop() - the caller must NOT spawn. */
  private acquireSlot(runId: string): Promise<(() => void) | null> {
    if (this.maxConcurrent === 0 || this.liveSlots < this.maxConcurrent) {
      this.liveSlots++;
      return Promise.resolve(() => this.releaseSlot());
    }
    return new Promise((resolve) => {
      this.slotQueue.push({ runId, resolve });
    });
  }

  private releaseSlot(): void {
    this.liveSlots--;
    while (
      this.maxConcurrent > 0 &&
      this.liveSlots < this.maxConcurrent &&
      this.slotQueue.length > 0
    ) {
      const next = this.slotQueue.shift()!;
      this.liveSlots++;
      next.resolve(() => this.releaseSlot());
    }
  }

  /** Cancel a queued slot wait (stop() on a not-yet-spawned Run). */
  private cancelQueuedSlot(runId: string): boolean {
    const idx = this.slotQueue.findIndex((w) => w.runId === runId);
    if (idx === -1) return false;
    const entry = this.slotQueue.splice(idx, 1)[0]!;
    entry.resolve(null);
    return true;
  }

  /** Spawn a fresh child for the Run, send execute, and return the segment
   *  ONLY after the child accepted (runtime assembled, steer/abort routable).
   *  On rejection the child is reaped and the input stays unaccepted. While
   *  waiting for a spawn slot the input is still delivering; stop() cancels
   *  the wait so the Run never spawns. */
  async execute(
    input: BackendRunInput<"coding_agent">,
  ): Promise<BackendRunSegment<"coding_agent">> {
    const runId = input.run.runId;
    if (this.disposed) {
      throw new CodingAgentProcessError("conflict", "backend is shutting down");
    }
    if (this.active.has(runId)) {
      throw new CodingAgentProcessError(
        "conflict",
        `runId ${runId} already has a live child process`,
      );
    }

    // Bounded live children: wait FIFO for a slot before spawning.
    const release = await this.acquireSlot(runId);
    if (release === null) {
      throw new CodingAgentProcessError(
        "conflict",
        `run ${runId} was stopped while waiting for a spawn slot`,
      );
    }
    debugLog("coding-agent-adapter", `slot_acquired runId=${runId}`);
    let released = false;
    const releaseOnce = (): void => {
      if (released) return;
      released = true;
      release();
    };

    let proc: SpawnedCodingAgentProcess;
    try {
      debugLog(
        "coding-agent-adapter",
        `spawning runId=${runId} executable=${this.command.executable} cwd=${input.workspace.root}`,
      );
      proc = spawnCodingAgentProcess(this.command, { cwd: input.workspace.root });
      debugLog("coding-agent-adapter", `spawned runId=${runId} pid=${proc.pid}`);
    } catch (err) {
      releaseOnce();
      throw new CodingAgentProcessError(
        "spawn_failed",
        err instanceof Error ? err.message : String(err),
      );
    }

    // Register the handle BEFORE acceptance so steer/stop route the moment
    // the caller sees the segment. The slot is held until the Run settles
    // (settle is exactly-once, covering outcome/exit/protocol-failure).
    const handle = createActiveHandle(runId, proc, releaseOnce);
    this.active.set(runId, handle);

    // Exit watcher: a child that dies before acceptance or before outcome is
    // a process failure - the outcome must settle, never hang. Pending
    // command responses for THIS run fail too (other runs are untouched).
    void proc.exit.then((code) => {
      debugLog("coding-agent-adapter", `child_exit runId=${runId} code=${code}`);
      const detail = describeProcessFailure(proc, `process exited (code ${code})`);
      const waiters = this.pendingResponses.get(runId);
      if (waiters) {
        for (const waiter of waiters.values()) {
          waiter.resolve({ success: false, error: detail });
        }
        this.pendingResponses.delete(runId);
      }
      // The outcome envelope is the ONLY terminal authority: an exit right
      // after the outcome (normal shutdown) never rewrites it.
      if (!handle.settled && !handle.outcomeReceived) {
        handle.settleAcceptance?.(detail);
        handle.settle({ status: "failed", error: detail });
        void this.reap(handle);
      }
    });

    // Single stdout routing task per handle.
    void consumeStdout(handle, this);

    proc.writeLine(JSON.stringify({ id: handle.executeCommandId, type: "execute", input }));
    debugLog("coding-agent-adapter", `execute_sent runId=${runId}`);

    const acceptanceError = await handle.acceptance;
    if (acceptanceError !== null) {
      // Settle explicitly: a child that REJECTED but kept running never
      // reaches the exit/outcome paths, and the spawn slot must be freed.
      handle.settle({ status: "failed", error: acceptanceError });
      await this.reap(handle);
      throw new CodingAgentProcessError(
        "invalid_request",
        `coding-agent rejected execute: ${acceptanceError}`,
      );
    }
    debugLog("coding-agent-adapter", `execute_accepted runId=${runId}`);
    return buildSegment(handle, this);
  }

  /** Inject a steer into the live child. No live child = explicit conflict. */
  async steer(runId: string, input: BackendInputMessage): Promise<void> {
    const handle = this.active.get(runId);
    if (!handle || handle.settled) {
      throw new CodingAgentProcessError("not_found", `no live child for run: ${runId}`);
    }
    const id = `steer-${runId}`;
    const response = await this.sendCommand(handle, id, {
      id,
      type: "steer",
      runId,
      input,
    });
    if (!response.success) {
      throw new CodingAgentProcessError("conflict", `steer rejected by child: ${response.error}`);
    }
  }

  /** Abort the live child: send abort, wait a bounded grace for the outcome,
   *  kill on timeout. The segment's outcome always resolves. A Run still
   *  waiting for a spawn slot is cancelled so it never spawns. */
  async stop(runId: string): Promise<void> {
    const handle = this.active.get(runId);
    if (!handle) {
      // No live child: either already settled/reaped, or queued for a slot.
      this.cancelQueuedSlot(runId);
      return;
    }
    const sendAbort = (): void => {
      if (handle.settled) return;
      void this.sendCommand(handle, `abort-${runId}`, {
        id: `abort-${runId}`,
        type: "abort",
        runId,
      }).catch(() => {});
    };
    if (handle.accepted) {
      sendAbort();
    } else {
      // Abort landed before acceptance: send it the moment the run is live.
      await handle.acceptance.then((err) => {
        if (err === null) sendAbort();
      });
    }
    const outcome = await withTimeout(
      handle.outcome.catch(() => null),
      this.abortGraceMs,
    );
    if (outcome === null) {
      // Grace exhausted: kill and settle - never hang.
      handle.proc.kill();
      handle.settle({
        status: "aborted",
        error: "coding-agent process did not stop within the abort grace period",
      });
      await this.reap(handle);
    }
  }

  /** Write a command and await its response envelope (id-matched). */
  private async sendCommand(
    handle: ActiveHandle,
    id: string,
    command: { id: string; type: "steer" | "abort"; runId: string; input?: BackendInputMessage },
  ): Promise<{ success: boolean; error?: string }> {
    const response = new Promise<{ success: boolean; error?: string }>((resolve) => {
      let waiters = this.pendingResponses.get(handle.runId);
      if (!waiters) {
        waiters = new Map();
        this.pendingResponses.set(handle.runId, waiters);
      }
      waiters.set(id, { resolve });
    });
    handle.proc.writeLine(JSON.stringify(command));
    const result = await response;
    this.pendingResponses.get(handle.runId)?.delete(id);
    return result;
  }

  /** Post-outcome cleanup: close stdin, bounded wait for exit, kill if
   *  needed, drop the active handle. */
  async reap(handle: ActiveHandle): Promise<void> {
    try {
      handle.proc.closeStdin();
    } catch {
      /* already closed */
    }
    const exited = await withTimeout(
      handle.proc.exit.catch(() => null),
      this.abortGraceMs,
    );
    if (exited === null) handle.proc.kill();
    if (this.active.get(handle.runId) === handle) {
      this.active.delete(handle.runId);
    }
    debugLog("coding-agent-adapter", `reaped runId=${handle.runId}`);
  }

  /** Protocol violation: settle failed, drop the handle, kill the child. */
  failProtocol(handle: ActiveHandle, reason: string): void {
    if (handle.settled) return;
    const detail = `${reason}: ${handle.proc.stderrTail.text()}`.slice(0, 2000);
    handle.settleAcceptance?.(detail);
    handle.settle({ status: "failed", error: detail });
    handle.proc.kill();
    void this.reap(handle);
  }

  /** Shut down EVERY child deterministically:
   *  1. reject new executes + cancel queued spawn-slot waiters;
   *  2. accepted children get a best-effort RPC abort;
   *  3. pre-acceptance children (acceptance may NEVER resolve, e.g. the
   *     child fell into the wrong mode) are SIGTERM'd directly;
   *  4. wait up to abortGraceMs for exit, then SIGKILL;
   *  5. reap every handle so `active` and the slot count drain.
   *  Never awaits `handle.acceptance` - a stuck child cannot block shutdown. */
  async dispose(): Promise<void> {
    this.disposed = true;

    for (const waiter of this.slotQueue.splice(0)) {
      waiter.resolve(null);
    }

    const handles = [...this.active.values()];
    for (const handle of handles) {
      if (handle.accepted) {
        void this.sendCommand(handle, `abort-${handle.runId}`, {
          id: `abort-${handle.runId}`,
          type: "abort",
          runId: handle.runId,
        }).catch(() => {});
      } else {
        // Pre-acceptance: no RPC is routable; terminate directly.
        handle.proc.kill("SIGTERM");
      }
    }

    await Promise.allSettled(
      handles.map(async (handle) => {
        const exited = await withTimeout(handle.proc.exit, this.abortGraceMs);
        if (exited === null) {
          handle.proc.kill("SIGKILL");
          await handle.proc.exit.catch(() => null);
        }
        await this.reap(handle);
      }),
    );
  }
}

// ─── Handle / segment plumbing ────────────────────────────────────────

function createActiveHandle(
  runId: string,
  proc: SpawnedCodingAgentProcess,
  onSettled: () => void,
): ActiveHandle {
  let settleOutcome: ((o: BackendRunOutcome) => void) | null = null;
  let settled = false;
  let accepted = false;
  let settleAcceptance: ((err: string | null) => void) | null = null;
  const queue: BackendEvent<"coding_agent">[] = [];
  const waiters: Array<() => void> = [];
  let eventsClosed = false;

  const outcome = new Promise<BackendRunOutcome>((resolve) => {
    settleOutcome = resolve;
  });
  const acceptance = new Promise<string | null>((resolve) => {
    settleAcceptance = resolve;
  });

  const handle: ActiveHandle = {
    runId,
    proc,
    executeCommandId: `execute-${runId}`,
    accepted: false,
    acceptance,
    settleAcceptance: null as never,
    outcomeReceived: false,
    settled: false,
    settle(o) {
      if (settled) return;
      settled = true;
      settleOutcome?.(o);
      eventsClosed = true;
      onSettled(); // exactly-once: frees the spawn slot
      for (const w of waiters.splice(0)) w();
    },
    outcome,
    pushEvent(envelope) {
      if (eventsClosed) return;
      queue.push(mapRunEvent(envelope));
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
  // Wire the acceptance setter after construction (self-reference).
  handle.settleAcceptance = (err) => {
    if (settleAcceptance) {
      settleAcceptance(err);
      settleAcceptance = null;
    }
    if (err === null) accepted = true;
    handle.accepted = accepted;
  };
  return handle;
}

function buildSegment(
  handle: ActiveHandle,
  backend: CodingAgentBackend,
): BackendRunSegment<"coding_agent"> {
  return {
    events: handle.events,
    outcome: handle.outcome,
    stop: () => backend.stop(handle.runId),
  };
}

/** Single stdout routing task: response → acceptance/command waiter, event →
 *  segment stream, outcome → terminal settle + reap. Malformed output is a
 *  protocol failure that settles the Run failed (never pollutes a state
 *  machine). */
async function consumeStdout(handle: ActiveHandle, backend: CodingAgentBackend): Promise<void> {
  try {
    for await (const line of handle.proc.stdout) {
      if (handle.settled) break;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        backend.failProtocol(handle, "malformed stdout: line is not JSON");
        break;
      }
      const out = codingAgentOutputSchema.safeParse(parsed);
      if (!out.success) {
        backend.failProtocol(handle, `malformed stdout envelope: ${out.error.message}`);
        break;
      }
      const output = out.data as CodingAgentOutput;
      if (output.type === "response") {
        const waiter = backend.pendingResponses.get(handle.runId)?.get(output.id);
        if (waiter) {
          waiter.resolve({ success: output.success, error: output.error });
          continue;
        }
        if (output.id === handle.executeCommandId) {
          handle.settleAcceptance?.(output.success ? null : (output.error ?? "execute rejected"));
          continue;
        }
        backend.failProtocol(handle, `unexpected response for unknown command id ${output.id}`);
        break;
      }
      if (output.type === "event") {
        if (output.runId !== handle.runId) {
          backend.failProtocol(handle, `event for unknown runId ${output.runId}`);
          break;
        }
        handle.pushEvent(output.event);
        continue;
      }
      // outcome
      if (output.runId !== handle.runId) {
        backend.failProtocol(handle, `outcome for unknown runId ${output.runId}`);
        break;
      }
      // Reap FIRST: when the outcome resolves, the child is gone and the
      // active handle is removed (one Run = one child, fully recycled).
      handle.outcomeReceived = true;
      await backend.reap(handle);
      debugLog(
        "coding-agent-adapter",
        `outcome runId=${handle.runId} status=${output.outcome.status}`,
      );
      handle.settle(mapRunOutcome(output.outcome));
      break;
    }
  } catch {
    /* reader teardown */
  }
  if (!handle.settled) {
    // stdout closed without an outcome: the child is gone. The exit code is
    // authoritative for the failure detail (the process exit resolves by the
    // time its stdout EOFs).
    const code = await handle.proc.exit.catch(() => null);
    const detail = describeProcessFailure(
      handle.proc,
      `process exited (code ${code}) before outcome`,
    );
    handle.settleAcceptance?.(detail);
    await backend.reap(handle);
    handle.settle({ status: "failed", error: detail });
  }
}

function describeProcessFailure(proc: SpawnedCodingAgentProcess, what: string): string {
  const tail = proc.stderrTail.text();
  return tail ? `${what}: ${tail}`.slice(0, 2000) : what;
}
