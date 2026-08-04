import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  AgentRunSnapshot,
  BackendInputMessage,
  ProjectedHistoryItem,
  WorkspaceBinding,
} from "@my-agent-team/agent-backend";
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
  idleTimeoutMs: number;
  /** sweep interval for sleeping idle sessions; 0 disables the reaper */
  reapIntervalMs?: number;
  /** Workspace root allowlist: requested roots must be within one of these. */
  workspaceRoots: readonly string[];
  /** Max concurrent Worker process spawns (FIFO startup semaphore). */
  maxStartingWorkers: number;
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
    env?: Readonly<Record<string, string>>;
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
  async function ensureWorker(
    rec: SessionRecord,
    backendSessionId: string,
    workspaceRoot: string,
    workspaceAccess: "read_only" | "read_write",
  ): Promise<WorkerProcessHandle> {
    if (rec.workerPid !== null) {
      throw err("busy", `session already has a live worker: ${backendSessionId}`);
    }
    return withStartupSlot(() =>
      spawnWorkerLocked(rec, backendSessionId, workspaceRoot, workspaceAccess),
    );
  }

  async function spawnWorkerLocked(
    rec: SessionRecord,
    backendSessionId: string,
    workspaceRoot: string,
    workspaceAccess: "read_only" | "read_write",
  ): Promise<WorkerProcessHandle> {
    const handle = spawnWorkerProcess({
      workerEntry: opts.workerEntry,
      env: {
        ...opts.authEnv,
        CODING_AGENT_DATA_DIR: opts.sessionsDir.replace(/\/sessions$/, ""),
      },
      cwd: opts.cwd,
      stopGraceMs: opts.workerStopGraceMs,
      acceptTimeoutMs: opts.acceptTimeoutMs,
      events: {
        onMessage: (msg) => handleWorkerMessage(backendSessionId, msg),
        onExit: () => handleWorkerExit(backendSessionId),
        onMalformedOutput: (line, _err) => {
          failActiveRun(backendSessionId, `malformed worker output: ${line.slice(0, 200)}`);
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
      workspaceRoot,
      workspaceAccess,
      backendKind: "coding_agent",
      productTools: rec.productTools as never,
      identity: rec.productIdentity as never,
    });
    return handle;
  }

  async function workerFor(
    rec: SessionRecord,
    backendSessionId: string,
  ): Promise<WorkerProcessHandle> {
    if (rec.state === "sleeping" || rec.workerPid === null) {
      // wake: start a new Worker over the same session file
      transition(rec, "starting");
      const handle = await ensureWorker(
        rec,
        backendSessionId,
        rec.workspaceRoot,
        rec.workspaceAccess,
      );
      transition(rec, "live");
      return handle;
    }
    if (rec.state !== "live") {
      throw err("busy", `session not live: ${backendSessionId}`);
    }
    // Reuse the handle registry
    return handles.get(backendSessionId)!;
  }

  const handles = new Map<string, WorkerProcessHandle>();

  /** Sleep idle sessions: close the Worker, keep the session file and record.
   *  Wake happens lazily in workerFor() on the next command. The state only
   *  becomes sleeping AFTER the Worker process has exited, so a wake never
   *  spawns a second Worker over the same SQLite file. */
  let reaping = false;
  async function sleepIdle(): Promise<void> {
    if (reaping) return;
    reaping = true;
    try {
      const now = Date.now();
      for (const [sessionId, rec] of sessions) {
        if (
          rec.state === "live" &&
          rec.activeRunId === null &&
          now - rec.lastActivityAt >= opts.idleTimeoutMs
        ) {
          const handle = handles.get(sessionId);
          if (handle) {
            rec.exiting = true;
            try {
              handle.shutdown();
              await handle.exited;
            } catch {
              /* worker already gone */
            }
            handles.delete(sessionId);
          }
          rec.workerPid = null;
          transition(rec, "sleeping");
        }
      }
    } finally {
      reaping = false;
    }
  }

  const reaper =
    opts.reapIntervalMs && opts.reapIntervalMs > 0
      ? setInterval(sleepIdle, opts.reapIntervalMs)
      : undefined;

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
      if (msg.runId !== rec.activeRunId) return; // stale/unknown run event
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
      eventBuffers.get(msg.runId)?.close();
      rec.activeRunId = null;
    } else if (msg.type === "command_error" || msg.type === "fatal") {
      if (msg.type === "fatal" || (rec.activeRunId && msg.commandId?.startsWith("start-"))) {
        failActiveRun(backendSessionId, msg.message);
      }
    }
  }

  function failActiveRun(backendSessionId: string, reason: string): void {
    const rec = sessions.get(backendSessionId);
    if (!rec) return;
    rec.crashedAt = Date.now();
    if (rec.activeRunId) {
      const runId = rec.activeRunId;
      outcomes.set(runId, { runId, status: "failed", error: reason });
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
      rec.workerPid = null;
    }
    if (canTransitionToCrashed(rec)) transition(rec, "crashed");
  }

  function canTransitionToCrashed(rec: SessionRecord): boolean {
    return rec.state === "live" || rec.state === "starting" || rec.state === "stopping";
  }

  function handleWorkerExit(backendSessionId: string): void {
    const rec = sessions.get(backendSessionId);
    if (!rec) return;
    rec.workerPid = null;
    handles.delete(backendSessionId);
    // Deliberate shutdown (sleep/close) is not a crash.
    if (rec.exiting) {
      rec.exiting = false;
      return;
    }
    // Unexpected exit during an active run => run failed
    if (rec.activeRunId) {
      failActiveRun(backendSessionId, "worker exited unexpectedly");
    } else if (rec.state === "live") {
      // Idle worker exited: treat as crashed (no active loop to recover)
      if (canTransitionToCrashed(rec)) transition(rec, "crashed");
    }
  }

  return {
    async startSession(input) {
      const replay = mutationResult(input.idempotencyKey, input);
      if (replay) return replay.replay as { backendSessionId: string; runId: string };
      if (sessions.has(input.backendSessionId)) {
        throw err("busy", `session already exists: ${input.backendSessionId}`);
      }
      const workspaceRoot = validateWorkspace(input.workspace.root);
      const runId = input.run.runId;
      const rec = createSessionRecord(input.backendSessionId);
      rec.workspaceRoot = workspaceRoot;
      rec.workspaceAccess = input.workspace.access;
      rec.productTools = input.run.productTools;
      rec.productIdentity = {
        runId,
        conversationId: input.metadata.conversationId,
        agentMemberId: input.metadata.agentMemberId,
        branchId: input.metadata.branchId,
      };
      // Acceptance first, state commit after: ensureWorker spawns + awaits the
      // open_session handshake. Only after the Worker accepted do we publish
      // the record, so a spawn/acceptance failure leaves no half-state.
      const handle = await ensureWorker(
        rec,
        input.backendSessionId,
        workspaceRoot,
        input.workspace.access,
      );
      sessions.set(input.backendSessionId, rec);
      handles.set(input.backendSessionId, handle);
      rec.activeRunId = runId;
      eventBuffers.set(runId, createRunEventBuffer(opts.eventBufferSize));
      transition(rec, "live");
      try {
        await handle.send({
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
        });
      } catch (err) {
        // Roll back the published state: no half-initialized session survives
        // a failed start_run acceptance.
        sessions.delete(input.backendSessionId);
        handles.delete(input.backendSessionId);
        eventBuffers.delete(runId);
        try {
          handle.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        throw err;
      }
      const result = { backendSessionId: input.backendSessionId, runId };
      recordMutation(input.idempotencyKey, input, result);
      return result;
    },

    async resumeSession(input) {
      const rec = sessions.get(input.backendSessionId);
      if (!rec) {
        // No live record: start fresh (session file may exist on disk)
        return this.startSession(input);
      }
      if (rec.activeRunId)
        throw err("busy", `session has an active run: ${input.backendSessionId}`);
      if (rec.state === "crashed") {
        // Crashed active loop is NOT resumable; a new session from fresh
        // context must use a different identity. Reject.
        throw err("invalid_request", `session crashed, not resumable: ${input.backendSessionId}`);
      }
      const handle = await workerFor(rec, input.backendSessionId);
      handles.set(input.backendSessionId, handle);
      const runId = input.run.runId;
      // Reserve the buffer before the command (no event-loss window); roll
      // back on rejection so no half-state remains.
      eventBuffers.set(runId, createRunEventBuffer(opts.eventBufferSize));
      try {
        await handle.send({
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
        });
      } catch (err) {
        eventBuffers.delete(runId);
        throw err;
      }
      rec.activeRunId = runId;
      const result = { backendSessionId: input.backendSessionId, runId };
      recordMutation(input.idempotencyKey, input, result);
      return result;
    },

    async send(input) {
      const replay = mutationResult(input.idempotencyKey, input);
      if (replay) return replay.replay as { accepted: boolean; runId: string; commandId: string };
      const rec = recordFor(input.backendSessionId);
      if (rec.state === "sleeping" || rec.workerPid === null) {
        const handle = await workerFor(rec, input.backendSessionId);
        handles.set(input.backendSessionId, handle);
      }
      if (rec.activeRunId && input.mode !== "steer") {
        throw err("busy", `session has an active run: ${input.backendSessionId}`);
      }
      if (input.mode === "steer" && !rec.activeRunId) {
        throw err("invalid_request", "steer requires an active run");
      }
      if (input.mode === "steer" && input.runId !== rec.activeRunId) {
        // Steer targets the CURRENT active run - it never names a new run.
        throw err(
          "invalid_request",
          `steer runId ${input.runId} does not match active run ${rec.activeRunId}`,
        );
      }
      const handle = handles.get(input.backendSessionId);
      if (!handle) throw err("busy", `no live worker: ${input.backendSessionId}`);
      const runId = input.runId;
      // Reserve the event buffer BEFORE the command so events the Worker emits
      // in the same stdout chunk as command_accepted are not lost. Roll back
      // the reservation if acceptance fails.
      if (input.mode !== "steer") {
        eventBuffers.set(runId, createRunEventBuffer(opts.eventBufferSize));
      }
      try {
        await handle.send({
          protocolVersion: 1,
          type: "send",
          commandId: input.commandId,
          backendSessionId: input.backendSessionId,
          runId,
          mode: input.mode,
          history: input.history as never,
          input: input.input as never,
          run: input.run as never,
        });
      } catch (err) {
        if (input.mode !== "steer") eventBuffers.delete(runId);
        throw err;
      }
      if (input.mode !== "steer") {
        rec.activeRunId = runId;
      }
      const result = { accepted: true, runId, commandId: input.commandId };
      recordMutation(input.idempotencyKey, input, result);
      return result;
    },

    async stop(input) {
      const replay = mutationResult(input.idempotencyKey, input);
      if (replay) return replay.replay as { stopped: boolean };
      const rec = recordFor(input.backendSessionId);
      const handle = handles.get(input.backendSessionId);
      if (handle && rec.activeRunId) {
        await handle.send({
          protocolVersion: 1,
          type: "stop_run",
          commandId: input.commandId,
          backendSessionId: input.backendSessionId,
          runId: input.runId ?? rec.activeRunId,
        });
      }
      const result = { stopped: true };
      recordMutation(input.idempotencyKey, input, result);
      return result;
    },

    async compact(input) {
      const replay = mutationResult(input.idempotencyKey, input);
      if (replay) return replay.replay as { compacted: boolean };
      const rec = recordFor(input.backendSessionId);
      if (rec.activeRunId) {
        throw err("busy", "manual compact is only allowed when idle");
      }
      const handle = await workerFor(rec, input.backendSessionId);
      handles.set(input.backendSessionId, handle);
      // compact's real completion is the command_result, not the intermediate
      // command_accepted - await the result so failure surfaces to the caller.
      await handle.sendForResult({
        protocolVersion: 1,
        type: "compact",
        commandId: input.commandId,
        backendSessionId: input.backendSessionId,
      });
      const result = { compacted: true };
      recordMutation(input.idempotencyKey, input, result);
      return result;
    },

    async close(input) {
      const replay = mutationResult(input.idempotencyKey, input);
      if (replay) return replay.replay as { closed: boolean };
      const rec = sessions.get(input.backendSessionId);
      if (!rec) {
        const result = { closed: true };
        recordMutation(input.idempotencyKey, input, result);
        return result;
      }
      const handle = handles.get(input.backendSessionId);
      if (handle) {
        rec.exiting = true;
        await handle.send({
          protocolVersion: 1,
          type: "close_session",
          commandId: `close-${input.backendSessionId}`,
          backendSessionId: input.backendSessionId,
          deleteData: input.deleteData ?? false,
        });
        // Wait for the Worker to actually exit before touching the session
        // file: a live Worker may still hold the SQLite handle.
        await handle.exited.catch(() => {});
        handles.delete(input.backendSessionId);
      }
      rec.workerPid = null;
      transition(rec, "stopping");
      transition(rec, "closed");
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

    getEvents(runId) {
      const buf = eventBuffers.get(runId);
      if (!buf) throw err("not_found", `no event stream for run: ${runId}`);
      return buf;
    },

    hasRun(runId) {
      return eventBuffers.has(runId) || outcomes.has(runId);
    },

    getOutcome(runId) {
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
      clearInterval(reaper);
      for (const [sessionId, rec] of sessions) {
        const handle = handles.get(sessionId);
        if (handle) {
          try {
            handle.shutdown();
          } catch {
            /* */
          }
          handles.delete(sessionId);
        }
        rec.workerPid = null;
        // crashed records can't transition to stopping/closed; they are
        // already terminal and just get dropped from the registry.
        if (rec.state !== "closed" && rec.state !== "crashed") {
          transition(rec, "stopping");
          transition(rec, "closed");
        }
      }
      sessions.clear();
      for (const b of eventBuffers.values()) b.close();
      eventBuffers.clear();
    },
  };
}
