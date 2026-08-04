import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  AgentRunSnapshot,
  BackendInputMessage,
  ProjectedHistoryItem,
  WorkspaceBinding,
} from "@my-agent-team/agent-backend";
import type { ModelRuntime } from "@my-agent-team/ai";
import { createRunEventBuffer, type RunEventBuffer } from "./event-buffer.js";
import { createSessionRecord, type SessionRecord, transition } from "./session-record.js";
import { spawnWorkerProcess, type WorkerProcessHandle } from "./worker-process.js";
import type { WorkerMessage } from "./worker-protocol.js";

/** Idempotent mutation result cache. Exact replay returns the original;
 *  same key + different payload returns conflict. */
interface MutationRecord {
  key: string;
  payloadHash: string;
  result: unknown;
}

export interface SupervisorOptions {
  workerEntry: string;
  cwd: string;
  sessionsDir: string;
  authEnv: Record<string, string>;
  eventBufferSize: number;
  workerStopGraceMs: number;
  /** Max ms to await Worker command acceptance before rejecting the mutation. */
  acceptTimeoutMs: number;
  /** Workspace root allowlist: requested roots must be within one of these. */
  workspaceRoots: readonly string[];
  /** Max concurrent Worker process spawns (FIFO startup semaphore). */
  maxStartingWorkers: number;
  /** Daemon ModelRuntime for preflight model validation (reject unknown /
   *  unavailable models at HTTP acceptance, not after the run starts). */
  modelRuntime?: ModelRuntime;
}

export interface SessionView {
  readonly backendSessionId: string;
  readonly state: string;
  readonly workerPid: number | null;
  readonly activeRunId: string | null;
}

export interface SupervisorError extends Error {
  code: "not_found" | "busy" | "conflict" | "invalid_request";
}

function err(code: SupervisorError["code"], message: string): SupervisorError {
  const e = new Error(message) as SupervisorError;
  e.code = code;
  return e;
}

function hashPayload(value: unknown): string {
  return JSON.stringify(value);
}

export interface CodingSessionSupervisor {
  startSession(input: {
    idempotencyKey: string;
    backendSessionId: string;
    history: readonly ProjectedHistoryItem[];
    input: BackendInputMessage;
    run: AgentRunSnapshot<"coding_agent">;
    workspace: WorkspaceBinding;
    metadata: {
      conversationId: string;
      agentMemberId: string;
      branchId: string;
      productRevision: number;
    };
  }): Promise<{ backendSessionId: string; runId: string }>;
  resumeSession(
    input: Parameters<CodingSessionSupervisor["startSession"]>[0],
  ): Promise<{ backendSessionId: string; runId: string }>;
  send(input: {
    idempotencyKey: string;
    commandId: string;
    backendSessionId: string;
    runId: string;
    mode: "normal" | "steer" | "follow_up";
    history: readonly ProjectedHistoryItem[];
    input: BackendInputMessage;
    run: AgentRunSnapshot<"coding_agent">;
    metadata: { branchId: string; throughEntryId?: string; productRevision: number };
  }): Promise<{ accepted: boolean; runId: string; commandId: string }>;
  stop(input: {
    idempotencyKey: string;
    commandId: string;
    backendSessionId: string;
    runId?: string;
  }): Promise<{ stopped: boolean }>;
  compact(input: {
    idempotencyKey: string;
    commandId: string;
    backendSessionId: string;
    runId?: string;
  }): Promise<{ compacted: boolean }>;
  close(input: {
    idempotencyKey: string;
    commandId: string;
    backendSessionId: string;
    deleteData?: boolean;
  }): Promise<{ closed: boolean }>;
  getEvents(runId: string): RunEventBuffer;
  hasRun(runId: string): boolean;
  getOutcome(runId: string): unknown | null;
  listSessions(): SessionView[];
  shutdown(): Promise<void>;
}

export function createCodingSessionSupervisor(opts: SupervisorOptions): CodingSessionSupervisor {
  mkdirSync(opts.sessionsDir, { recursive: true });
  // Canonicalize the allowlist at construction (matching config's realpath):
  // tests and callers may pass raw /tmp paths; on macOS /tmp -> /private/tmp.
  const workspaceRoots = opts.workspaceRoots.map((r) => realpathSync(resolve(r)));
  const sessions = new Map<string, SessionRecord>();
  const eventBuffers = new Map<string, RunEventBuffer>();
  const outcomes = new Map<string, unknown>();
  const mutations = new Map<string, MutationRecord>();

  // FIFO startup semaphore: bounds concurrent Worker spawns (Phase 3 resource
  // limit). Spawners queue; a slot frees when a spawn completes or fails.
  let startingWorkers = 0;
  const startupQueue: Array<() => void> = [];
  async function withStartupSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (startingWorkers < opts.maxStartingWorkers) {
      startingWorkers++;
      try {
        return await fn();
      } finally {
        startingWorkers--;
        startupQueue.shift()?.();
      }
    }
    await new Promise<void>((resolve) => startupQueue.push(resolve));
    return withStartupSlot(fn);
  }

  function recordFor(sessionId: string): SessionRecord {
    const rec = sessions.get(sessionId);
    if (!rec) throw err("not_found", `session not found: ${sessionId}`);
    return rec;
  }

  // ─── Mutation serialization ─────────────────────────────────────────
  // Concurrent HTTP mutations can corrupt session state: two identical
  // starts could double-spawn a Worker over the same SQLite file, and two
  // idle sends could otherwise both reserve a run. Every mutation is
  // therefore BOTH deduped by idempotency key (a concurrent duplicate joins
  // the in-flight promise instead of executing twice) AND serialized per
  // session (the next mutation waits for the previous one's acceptance to
  // settle, including its Worker round-trip).
  const mutationChains = new Map<string, Promise<unknown>>();
  const inFlightMutations = new Map<string, { payloadHash: string; promise: Promise<unknown> }>();

  function serialized<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = mutationChains.get(sessionId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    mutationChains.set(sessionId, run);
    // Clean the chain slot when the run settles. Both branches must handle
    // the rejection: a bare `void run.finally(...)` would leave the
    // finally-promise itself unhandled whenever the mutation rejects.
    const cleanup = (): void => {
      if (mutationChains.get(sessionId) === run) mutationChains.delete(sessionId);
    };
    void run.then(cleanup, cleanup);
    return run;
  }

  /** Dedupe concurrent mutations by idempotency key AND payload: a duplicate
   *  with the SAME key and SAME payload joins the in-flight promise (one
   *  Worker spawn); the same key with a DIFFERENT payload conflicts
   *  immediately - the settled-result cache already enforces this, so the
   *  in-flight window must too. */
  function deduped<T>(key: string, payload: unknown, fn: () => Promise<T>): Promise<T> {
    const existing = inFlightMutations.get(key);
    if (existing) {
      if (existing.payloadHash !== hashPayload(payload)) {
        throw err("conflict", `idempotency key ${key} reused with different payload`);
      }
      return existing.promise as Promise<T>;
    }
    const p = fn().finally(() => {
      if (inFlightMutations.get(key)?.promise === p) inFlightMutations.delete(key);
    });
    inFlightMutations.set(key, { payloadHash: hashPayload(payload), promise: p });
    return p;
  }

  /** Resolve when the run settles (or the bound elapses) - used by close() to
   *  bound the stop->outcome window instead of waiting on a stuck loop. */
  const outcomeWaiters = new Map<string, Array<() => void>>();
  function waitForOutcome(runId: string, timeoutMs: number): Promise<boolean> {
    if (outcomes.has(runId)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const arr = outcomeWaiters.get(runId) ?? [];
      const remove = (): void => {
        const idx = arr.indexOf(notify);
        if (idx >= 0) arr.splice(idx, 1);
        if (arr.length === 0) outcomeWaiters.delete(runId);
      };
      const timer = setTimeout(() => {
        remove();
        resolve(false);
      }, timeoutMs);
      const notify = (): void => {
        clearTimeout(timer);
        remove();
        resolve(true);
      };
      arr.push(notify);
      outcomeWaiters.set(runId, arr);
    });
  }

  function notifyOutcomeWaiters(runId: string): void {
    const arr = outcomeWaiters.get(runId);
    if (arr) {
      outcomeWaiters.delete(runId);
      for (const w of arr) w();
    }
  }

  function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      promise.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  function mutationResult(key: string, payload: unknown): { replay: unknown } | null {
    const existing = mutations.get(key);
    if (!existing) return null;
    if (existing.payloadHash !== hashPayload(payload)) {
      throw err("conflict", `idempotency key ${key} reused with different payload`);
    }
    return { replay: existing.result };
  }

  function recordMutation(key: string, payload: unknown, result: unknown): void {
    mutations.set(key, { key, payloadHash: hashPayload(payload), result });
  }

  /** A runId owned by another session's live buffer or settled outcome is a
   *  trust-boundary collision, never a silent overwrite. start/resume/send
   *  share this check so no path can hijack an existing run's identity. */
  function assertRunIdAvailable(runId: string): void {
    if (eventBuffers.has(runId) || outcomes.has(runId)) {
      throw err("conflict", `runId already in use: ${runId}`);
    }
  }

  /** Preflight model validation: reject unknown/unavailable models at HTTP
   *  acceptance so the caller can distinguish config errors from accepted-then-
   *  failed runs. */
  async function validateModel(modelId: string): Promise<void> {
    if (!opts.modelRuntime) return;
    const catalog = await opts.modelRuntime.getCatalog();
    const model = catalog.models.find((m) => `${m.providerId}/${m.modelId}` === modelId);
    if (!model) {
      throw err("invalid_request", `model not found in daemon catalog: ${modelId}`);
    }
    if (model.available === false) {
      throw err("invalid_request", `model unavailable: ${modelId}`);
    }
  }

  /** Validate a requested workspace root is within the configured allowlist.
   *  Both sides canonicalize with realpathSync (matching config's allowlist),
   *  so symlinked roots like macOS /tmp -> /private/tmp compare equal. */
  function validateWorkspace(root: string): string {
    const resolved = realpathSync(resolve(root));
    const allowed = workspaceRoots.some((a) => resolved === a || resolved.startsWith(`${a}/`));
    if (!allowed) {
      throw err("invalid_request", `workspace root not in allowlist: ${resolved}`);
    }
    return resolved;
  }

  /** One-shot Worker spawn: process + open_session handshake over the
   *  session's binding and run identity. The Worker lives exactly as long as
   *  its single command. */
  async function spawnRunWorker(rec: SessionRecord): Promise<WorkerProcessHandle> {
    return withStartupSlot(() => spawnWorkerLocked(rec));
  }

  async function spawnWorkerLocked(rec: SessionRecord): Promise<WorkerProcessHandle> {
    const backendSessionId = rec.backendSessionId;
    const handle = spawnWorkerProcess({
      workerEntry: opts.workerEntry,
      env: {
        ...opts.authEnv,
        // Workers spawn MCP stdio children (Product Tools) via their own
        // PATH - inherit the daemon's so `bun`/executables resolve.
        PATH: process.env.PATH ?? "",
        CODING_AGENT_DATA_DIR: opts.sessionsDir.replace(/\/sessions$/, ""),
      },
      cwd: opts.cwd,
      stopGraceMs: opts.workerStopGraceMs,
      acceptTimeoutMs: opts.acceptTimeoutMs,
      events: {
        onMessage: (msg) => handleWorkerMessage(backendSessionId, msg),
        onExit: () => handleWorkerExit(backendSessionId),
        onMalformedOutput: (line, _err) => {
          failRun(backendSessionId, `malformed worker output: ${line.slice(0, 200)}`);
          handle.kill("SIGKILL");
        },
      },
    });
    rec.workerPid = handle.pid;
    await handle.send({
      protocolVersion: 1,
      type: "open_session",
      commandId: `open-${backendSessionId}`,
      backendSessionId,
      dataDir: opts.sessionsDir.replace(/\/sessions$/, ""),
      workspaceRoot: rec.workspaceRoot,
      workspaceAccess: rec.workspaceAccess,
      backendKind: "coding_agent",
      identity: { conversationId: rec.conversationId, agentMemberId: rec.agentMemberId },
    });
    return handle;
  }

  /** Live Worker handles, keyed by session id (the record keeps the pid for
   *  observability; the handle is needed for control commands). */
  const handles = new Map<string, WorkerProcessHandle>();

  function handleWorkerMessage(backendSessionId: string, msg: WorkerMessage): void {
    const rec = sessions.get(backendSessionId);
    if (!rec) return;
    rec.lastActivityAt = Date.now();
    // Identity validation: a crossed/forged message must not affect this
    // session's events or runs - drop it. (The supervisor's own shutdown
    // sentinel carries backendSessionId "shutdown", which is deliberately
    // not this session; dropping is harmless.)
    if ("backendSessionId" in msg && msg.backendSessionId !== backendSessionId) {
      return;
    }
    if (msg.type === "event") {
      // Only the session's current run may emit events. A stale/unknown run
      // (after close or from a crossed message) is dropped.
      if (msg.runId !== rec.activeRunId) return;
      const buf = eventBuffers.get(msg.runId);
      if (buf) {
        buf.append({
          type: (msg.event as { type?: string }).type ?? "runtime",
          data: msg.event as Record<string, unknown>,
        });
      }
    } else if (msg.type === "outcome") {
      // Terminal outcomes are first-write-wins: a later outcome for the same
      // run (or a replay after close) must not overwrite the settled one.
      if (outcomes.has(msg.runId)) return;
      if (msg.runId !== rec.activeRunId) return;
      outcomes.set(msg.runId, { runId: msg.runId, ...(msg.outcome as object) });
      notifyOutcomeWaiters(msg.runId);
      eventBuffers.get(msg.runId)?.close();
    } else if (msg.type === "command_error" || msg.type === "fatal") {
      if (msg.type === "fatal" || (rec.activeRunId && msg.commandId?.startsWith("start-"))) {
        failRun(backendSessionId, msg.message);
      }
    }
  }

  function canTransitionToCrashed(rec: SessionRecord): boolean {
    return rec.state === "starting" || rec.state === "running" || rec.state === "closing";
  }

  /** Fail the session's current run (if any) and mark the session crashed.
   *  The run's event buffer is closed and a first-write-wins failed outcome
   *  is published so callers never poll a phantom run forever. */
  function failRun(backendSessionId: string, reason: string): void {
    const rec = sessions.get(backendSessionId);
    if (!rec) return;
    const runId = rec.activeRunId;
    if (runId) {
      if (!outcomes.has(runId)) {
        outcomes.set(runId, { runId, status: "failed", error: reason });
        notifyOutcomeWaiters(runId);
      }
      eventBuffers.get(runId)?.close();
      rec.activeRunId = null;
    }
    const handle = handles.get(backendSessionId);
    if (handle) {
      try {
        handle.kill("SIGKILL");
      } catch {
        /* */
      }
      handles.delete(backendSessionId);
    }
    rec.workerPid = null;
    if (canTransitionToCrashed(rec)) transition(rec, "crashed");
  }

  function handleWorkerExit(backendSessionId: string): void {
    const rec = sessions.get(backendSessionId);
    if (!rec) return;
    rec.workerPid = null;
    handles.delete(backendSessionId);
    // close/shutdown own the teardown of their worker.
    if (rec.state === "closing" || rec.state === "closed") return;
    const runId = rec.activeRunId;
    if (runId) {
      if (outcomes.has(runId)) {
        // Normal one-shot completion: the run settled (outcome emitted) and
        // the Worker exited. The session returns to idle for the next Run.
        rec.activeRunId = null;
        if (rec.state === "running") transition(rec, "idle");
        return;
      }
      // The Worker died without settling its run: fail it.
      failRun(backendSessionId, "worker exited unexpectedly");
      return;
    }
    // No active run: a maintenance Worker (compact) exits normally while the
    // session is starting; an idle-session Worker exiting is a crash.
    if (rec.state === "starting") return;
    if (rec.state === "running" && canTransitionToCrashed(rec)) transition(rec, "crashed");
  }

  type StartInput = Parameters<CodingSessionSupervisor["startSession"]>[0];
  type SendInput = Parameters<CodingSessionSupervisor["send"]>[0];
  type StopInput = Parameters<CodingSessionSupervisor["stop"]>[0];
  type CompactInput = Parameters<CodingSessionSupervisor["compact"]>[0];
  type CloseInput = Parameters<CodingSessionSupervisor["close"]>[0];

  /** Shared body for every "run a new Run on this session" path: reserve the
   *  run (activeRunId + buffer) BEFORE the Worker exists - no event/outcome
   *  can arrive before acceptance, and activeRunId gates every worker
   *  message - then spawn the one-shot Worker, hand it the command, and let
   *  it execute and exit. Rollback restores the session to idle. */
  async function runOnSession(
    rec: SessionRecord,
    runId: string,
    command: (handle: WorkerProcessHandle) => Promise<unknown>,
  ): Promise<void> {
    rec.activeRunId = runId;
    eventBuffers.set(runId, createRunEventBuffer(opts.eventBufferSize));
    transition(rec, "starting");
    let handle: WorkerProcessHandle | null = null;
    try {
      handle = await spawnRunWorker(rec);
      handles.set(rec.backendSessionId, handle);
      transition(rec, "running");
      await command(handle);
    } catch (err) {
      rec.activeRunId = null;
      eventBuffers.delete(runId);
      handles.delete(rec.backendSessionId);
      rec.workerPid = null;
      if (handle) {
        try {
          handle.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
      if (rec.state === "starting" || rec.state === "running") transition(rec, "idle");
      throw err;
    }
  }

  const api = {
    async startSessionInner(input: StartInput) {
      const replay = mutationResult(input.idempotencyKey, input);
      if (replay) return replay.replay as { backendSessionId: string; runId: string };
      if (sessions.has(input.backendSessionId)) {
        throw err("busy", `session already exists: ${input.backendSessionId}`);
      }
      const workspaceRoot = validateWorkspace(input.workspace.root);
      await validateModel(input.run.model.modelId);
      const runId = input.run.runId;
      assertRunIdAvailable(runId);
      const rec = createSessionRecord(input.backendSessionId);
      rec.workspaceRoot = workspaceRoot;
      rec.workspaceAccess = input.workspace.access;
      rec.conversationId = input.metadata.conversationId;
      rec.agentMemberId = input.metadata.agentMemberId;
      sessions.set(input.backendSessionId, rec);
      try {
        await runOnSession(rec, runId, (handle) =>
          handle.send({
            protocolVersion: 1,
            type: "start_run",
            commandId: `start-${runId}`,
            backendSessionId: input.backendSessionId,
            runId,
            mode: "normal",
            history: input.history as never,
            input: input.input as never,
            run: input.run as never,
            workspace: input.workspace,
            metadata: input.metadata,
          }),
        );
      } catch (err) {
        // A first start that never got accepted establishes NO session:
        // remove the fresh record so the same idempotency key can be retried
        // (a partially-created SQLite file is still reachable via resume /
        // a fresh start over the same file - never via this dead record).
        sessions.delete(input.backendSessionId);
        throw err;
      }
      const result = { backendSessionId: input.backendSessionId, runId };
      recordMutation(input.idempotencyKey, input, result);
      return result;
    },
    startSession(input: StartInput) {
      return deduped(input.idempotencyKey, input, () =>
        serialized(input.backendSessionId, () => this.startSessionInner(input)),
      );
    },

    async resumeSessionInner(input: StartInput) {
      // Idempotent replay: the same resume mutation returns the original
      // result instead of re-starting the run or surfacing a spurious busy.
      const replay = mutationResult(input.idempotencyKey, input);
      if (replay) return replay.replay as { backendSessionId: string; runId: string };
      const rec = sessions.get(input.backendSessionId);
      if (!rec) {
        // No live record: start fresh (session file may exist on disk)
        return this.startSession(input);
      }
      if (rec.state === "crashed") {
        // Crashed active loop is NOT resumable; a new session from fresh
        // context must use a different identity. Reject.
        throw err("invalid_request", `session crashed, not resumable: ${input.backendSessionId}`);
      }
      if (rec.activeRunId)
        throw err("busy", `session has an active run: ${input.backendSessionId}`);
      if (rec.state !== "idle") {
        throw err("busy", `session not idle: ${input.backendSessionId}`);
      }
      // The session's Worker tools are bound to the workspace established at
      // start. A resume naming a different root/access would render Meta and
      // the actual tool sandbox inconsistent - reject instead of accepting a
      // workspace that the tools do not honor.
      const requestedRoot = validateWorkspace(input.workspace.root);
      if (requestedRoot !== rec.workspaceRoot || input.workspace.access !== rec.workspaceAccess) {
        throw err(
          "invalid_request",
          `workspace binding mismatch for ${input.backendSessionId}: session is ${rec.workspaceRoot}/${rec.workspaceAccess}, got ${requestedRoot}/${input.workspace.access}`,
        );
      }
      await validateModel(input.run.model.modelId);
      const runId = input.run.runId;
      assertRunIdAvailable(runId);
      await runOnSession(rec, runId, (handle) =>
        handle.send({
          protocolVersion: 1,
          type: "start_run",
          commandId: `start-${runId}`,
          backendSessionId: input.backendSessionId,
          runId,
          mode: "normal",
          history: input.history as never,
          input: input.input as never,
          run: input.run as never,
          workspace: input.workspace,
          metadata: input.metadata,
        }),
      );
      const result = { backendSessionId: input.backendSessionId, runId };
      recordMutation(input.idempotencyKey, input, result);
      return result;
    },
    resumeSession(input: StartInput) {
      return deduped(input.idempotencyKey, input, () =>
        serialized(input.backendSessionId, () => this.resumeSessionInner(input)),
      );
    },

    async sendInner(input: SendInput) {
      const replay = mutationResult(input.idempotencyKey, input);
      if (replay) return replay.replay as { accepted: boolean; runId: string; commandId: string };
      const rec = recordFor(input.backendSessionId);
      if (input.mode === "steer") {
        // Steer targets the CURRENT active Run's Worker: no new Run, no new
        // Worker, no runId change. Returns under the active run identity.
        if (!rec.activeRunId || rec.state !== "running") {
          throw err("invalid_request", "steer requires an active run");
        }
        if (input.runId !== rec.activeRunId) {
          throw err(
            "invalid_request",
            `steer runId ${input.runId} does not match active run ${rec.activeRunId}`,
          );
        }
        const handle = handles.get(input.backendSessionId);
        if (!handle) throw err("busy", `no live worker: ${input.backendSessionId}`);
        await handle.send({
          protocolVersion: 1,
          type: "send",
          commandId: input.commandId,
          backendSessionId: input.backendSessionId,
          runId: rec.activeRunId,
          mode: "steer",
          history: input.history as never,
          input: input.input as never,
          run: input.run as never,
          metadata: input.metadata as never,
        });
        const result = { accepted: true, runId: rec.activeRunId, commandId: input.commandId };
        recordMutation(input.idempotencyKey, input, result);
        return result;
      }
      if (rec.state !== "idle") {
        throw err("busy", `session not idle: ${input.backendSessionId}`);
      }
      if (rec.activeRunId)
        throw err("busy", `session has an active run: ${input.backendSessionId}`);
      await validateModel(input.run.model.modelId);
      const runId = input.runId;
      assertRunIdAvailable(runId);
      await runOnSession(rec, runId, (handle) =>
        handle.send({
          protocolVersion: 1,
          type: "send",
          commandId: input.commandId,
          backendSessionId: input.backendSessionId,
          runId,
          mode: input.mode,
          history: input.history as never,
          input: input.input as never,
          run: input.run as never,
          metadata: input.metadata as never,
        }),
      );
      const result = { accepted: true, runId, commandId: input.commandId };
      recordMutation(input.idempotencyKey, input, result);
      return result;
    },
    send(input: SendInput) {
      return deduped(input.idempotencyKey, input, () =>
        serialized(input.backendSessionId, () => this.sendInner(input)),
      );
    },

    async stopInner(input: StopInput) {
      const replay = mutationResult(input.idempotencyKey, input);
      if (replay) return replay.replay as { stopped: boolean };
      const rec = recordFor(input.backendSessionId);
      const runId = rec.activeRunId;
      const handle = runId ? handles.get(input.backendSessionId) : undefined;
      if (handle && runId) {
        await handle.send({
          protocolVersion: 1,
          type: "stop_run",
          commandId: input.commandId,
          backendSessionId: input.backendSessionId,
          runId: input.runId ?? runId,
        });
      }
      const result = { stopped: true };
      recordMutation(input.idempotencyKey, input, result);
      return result;
    },
    stop(input: StopInput) {
      return deduped(input.idempotencyKey, input, () =>
        serialized(input.backendSessionId, () => this.stopInner(input)),
      );
    },

    async compactInner(input: CompactInput) {
      const replay = mutationResult(input.idempotencyKey, input);
      if (replay) return replay.replay as { compacted: boolean };
      const rec = recordFor(input.backendSessionId);
      if (rec.activeRunId) {
        throw err("busy", "manual compact is only allowed when idle");
      }
      if (rec.state !== "idle") {
        throw err("busy", `session not idle: ${input.backendSessionId}`);
      }
      // Compact is a one-shot MAINTENANCE Worker: open the SessionStore,
      // compact, emit command_result, exit. HTTP returns only after the
      // result - command_accepted is never the completion.
      transition(rec, "starting");
      let handle: WorkerProcessHandle | null = null;
      try {
        handle = await spawnRunWorker(rec);
        handles.set(input.backendSessionId, handle);
        await handle.sendForResult({
          protocolVersion: 1,
          type: "compact",
          commandId: input.commandId,
          backendSessionId: input.backendSessionId,
        });
        // The Worker exits itself after the result; bound + escalate.
        try {
          await withTimeout(handle.exited, opts.workerStopGraceMs);
        } catch {
          handle.kill("SIGTERM");
          try {
            await withTimeout(handle.exited, opts.workerStopGraceMs);
          } catch {
            handle.kill("SIGKILL");
            await handle.exited.catch(() => {});
          }
        }
        handles.delete(input.backendSessionId);
        rec.workerPid = null;
        transition(rec, "idle");
      } catch (err) {
        handles.delete(input.backendSessionId);
        rec.workerPid = null;
        if (handle) {
          try {
            handle.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }
        try {
          transition(rec, "idle");
        } catch {
          /* already terminal */
        }
        throw err;
      }
      const result = { compacted: true };
      recordMutation(input.idempotencyKey, input, result);
      return result;
    },
    compact(input: CompactInput) {
      return deduped(input.idempotencyKey, input, () =>
        serialized(input.backendSessionId, () => this.compactInner(input)),
      );
    },

    async closeInner(input: CloseInput) {
      const replay = mutationResult(input.idempotencyKey, input);
      if (replay) return replay.replay as { closed: boolean };
      const rec = sessions.get(input.backendSessionId);
      if (!rec) {
        const result = { closed: true };
        recordMutation(input.idempotencyKey, input, result);
        return result;
      }
      // 1. Stop any live run via the CONTROL path first, with a bounded
      //    outcome window. The run's one-shot Worker would otherwise finish
      //    its loop at its own pace.
      transition(rec, "closing");
      const runId = rec.activeRunId;
      const liveHandle = runId ? handles.get(input.backendSessionId) : undefined;
      if (liveHandle && runId) {
        try {
          await liveHandle.send({
            protocolVersion: 1,
            type: "stop_run",
            commandId: `stop-close-${input.backendSessionId}`,
            backendSessionId: input.backendSessionId,
            runId,
          });
          await waitForOutcome(runId, opts.acceptTimeoutMs);
        } catch {
          /* worker already gone - close_session will fail below */
        }
      }
      // 2. close_session (when a Worker is still live) then a bounded process
      //    exit with SIGTERM -> SIGKILL escalation, so a stuck loop or MCP
      //    teardown cannot hang the HTTP close.
      const handle = handles.get(input.backendSessionId);
      if (handle) {
        try {
          await handle.send({
            protocolVersion: 1,
            type: "close_session",
            commandId: `close-${input.backendSessionId}`,
            backendSessionId: input.backendSessionId,
            deleteData: input.deleteData ?? false,
          });
        } catch {
          /* worker already gone */
        }
        try {
          await withTimeout(handle.exited, opts.workerStopGraceMs);
        } catch {
          handle.kill("SIGTERM");
          try {
            await withTimeout(handle.exited, opts.workerStopGraceMs);
          } catch {
            handle.kill("SIGKILL");
            await handle.exited.catch(() => {});
          }
        }
        handles.delete(input.backendSessionId);
      }
      rec.workerPid = null;
      if (rec.state === "closing") transition(rec, "closed");
      // 3. Delete the SessionStore files (all three WAL artifacts).
      if (input.deleteData) {
        try {
          const base = join(opts.sessionsDir, input.backendSessionId);
          Bun.spawnSync(["rm", "-f", `${base}.sqlite`, `${base}.sqlite-wal`, `${base}.sqlite-shm`]);
        } catch {
          /* */
        }
      }
      sessions.delete(input.backendSessionId);
      const result = { closed: true };
      recordMutation(input.idempotencyKey, input, result);
      return result;
    },
    close(input: CloseInput) {
      return deduped(input.idempotencyKey, input, () =>
        serialized(input.backendSessionId, () => this.closeInner(input)),
      );
    },

    getEvents(runId: string) {
      const buf = eventBuffers.get(runId);
      if (!buf) throw err("not_found", `no event stream for run: ${runId}`);
      return buf;
    },

    hasRun(runId: string) {
      return eventBuffers.has(runId) || outcomes.has(runId);
    },

    getOutcome(runId: string) {
      return outcomes.get(runId) ?? null;
    },

    listSessions() {
      return Array.from(sessions.values()).map((rec) => ({
        backendSessionId: rec.backendSessionId,
        state: rec.state,
        workerPid: rec.workerPid,
        activeRunId: rec.activeRunId,
      }));
    },

    async shutdown() {
      // Collect every Worker's exit promise, then await them all so the
      // daemon does not tear down while a Worker still holds a session file.
      const exits: Promise<number | null>[] = [];
      for (const [sessionId, rec] of sessions) {
        const handle = handles.get(sessionId);
        if (handle) {
          try {
            handle.shutdown();
            exits.push(handle.exited);
          } catch {
            /* */
          }
          handles.delete(sessionId);
        }
        rec.workerPid = null;
        if (rec.state !== "closed" && rec.state !== "crashed") {
          try {
            transition(rec, "closing");
            transition(rec, "closed");
          } catch {
            /* already terminal */
          }
        }
      }
      await Promise.allSettled(exits);
      sessions.clear();
      for (const b of eventBuffers.values()) b.close();
      eventBuffers.clear();
    },
    // The literal also carries the *Inner bodies (not on the public
    // interface); the wrappers above are the typed public surface.
  };
  return api as CodingSessionSupervisor;
}
