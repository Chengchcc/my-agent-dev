import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { CodingAgentLoopResult } from "@my-agent-team/agent";
import type {
  AgentRunSnapshot,
  BackendInputMessage,
  ProjectedHistoryItem,
  RunOutcomeResponse,
  WorkspaceBinding,
} from "@my-agent-team/agent-backend";
import type { ModelRuntime } from "@my-agent-team/ai";
import { createRunEventBuffer, type RunEventBuffer } from "./event-buffer.js";
import { assembleRunRuntime, type RunRuntime, type RunRuntimeDeps } from "./run-runtime.js";

/** In-memory per-Run live registry. `runId` is the ONLY execution identity:
 *  no sessions, no Workers, no durable state. A Run's loop runs directly in
 *  the daemon process with its own fresh in-memory SessionStore. After a
 *  daemon restart nothing is remembered, so Product Backend may re-execute a
 *  Run that never reached a terminal commit (Product terminal commit +
 *  Product Tool idempotency guard against replays). */

interface ActiveRun {
  readonly runId: string;
  readonly buffer: RunEventBuffer;
  runtime: RunRuntime | null;
  settled: boolean;
  /** Set by stop() before the loop starts: the loop must not begin. */
  stopRequested: boolean;
  /** Resolves when the Run's loop is live (agent_start) or the Run settled
   *  without starting; rejects when acceptance failed (assembly error).
   *  execute() awaits it so `accepted` implies steer/stop routable. */
  startResolve: (() => void) | null;
  startReject: ((err: Error) => void) | null;
}

/** Idempotent execute-result cache: runId -> payload hash + accepted result.
 *  Same runId + same payload replays the original; different payload
 *  conflicts. Bounded by daemon lifetime (restart clears it). */
interface ExecuteRecord {
  payloadHash: string;
  result: { runId: string; accepted: boolean };
}

export interface RunRegistryOptions {
  /** Workspace root allowlist: requested roots must be within one of these. */
  workspaceRoots: readonly string[];
  eventBufferSize: number;
  /** Daemon ModelRuntime: preflight model validation at HTTP acceptance AND
   *  the model stream for every Run loop. */
  modelRuntime: ModelRuntime;
  /** Injectable for tests. */
  runtimeFactory?: (deps: RunRuntimeDeps) => Promise<RunRuntime>;
}

export interface RegistryError extends Error {
  code: "not_found" | "conflict" | "invalid_request";
}

function err(code: RegistryError["code"], message: string): RegistryError {
  const e = new Error(message) as RegistryError;
  e.code = code;
  return e;
}

function hashPayload(value: unknown): string {
  return JSON.stringify(value);
}

export interface CodingRunRegistry {
  /** Register and accept a Run. Idempotent for same runId + same payload;
   *  same runId + different payload conflicts. `accepted` means the run is
   *  registered and steer/stop routable. */
  execute(input: {
    history: readonly ProjectedHistoryItem[];
    input: BackendInputMessage;
    run: AgentRunSnapshot<"coding_agent">;
    workspace: WorkspaceBinding;
    metadata: {
      conversationId: string;
      agentMemberId: string;
      branchId: string;
    };
  }): Promise<{ runId: string; accepted: boolean }>;
  /** Inject a steer input into the LIVE run. Fails explicitly when the run
   *  is not live - never silently converted into a normal input. */
  steer(runId: string, input: BackendInputMessage): Promise<void>;
  /** Request cancellation of the target Run. Idempotent: stopping an
   *  already-settled run is a no-op. */
  stop(runId: string): Promise<void>;
  getEvents(runId: string): RunEventBuffer;
  hasRun(runId: string): boolean;
  getOutcome(runId: string): unknown | null;
  shutdown(): Promise<void>;
}

export function createCodingRunRegistry(opts: RunRegistryOptions): CodingRunRegistry {
  // Canonicalize the allowlist at construction (matching config's realpath):
  // tests and callers may pass raw /tmp paths; on macOS /tmp -> /private/tmp.
  const workspaceRoots = opts.workspaceRoots.map((r) => realpathSync(resolve(r)));
  const activeRuns = new Map<string, ActiveRun>();
  const eventBuffers = new Map<string, RunEventBuffer>();
  const outcomes = new Map<string, RunOutcomeResponse>();
  const executed = new Map<string, ExecuteRecord>();
  const inflight = new Map<string, Promise<unknown>>();
  let shuttingDown = false;

  /** Preflight model validation: reject unknown/unavailable models at HTTP
   *  acceptance so the caller can distinguish config errors from accepted-
   *  then-failed runs. */
  async function validateModel(modelId: string): Promise<void> {
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

  /** Map the canonical CodingAgentLoopResult to the wire outcome. The output
   *  Message is the persisted assistant entry (blocks intact); error is the
   *  redacted terminal reason - never a generic placeholder. */
  function mapLoopResult(result: CodingAgentLoopResult, runId: string): RunOutcomeResponse {
    if (result.status === "completed") {
      // No fabricated output: when the loop persisted no canonical assistant
      // Message, omit it rather than inventing an empty one.
      return {
        runId,
        status: "completed",
        ...(result.output ? { output: result.output as never } : {}),
        ...(result.usage ? { usage: result.usage as never } : {}),
      };
    }
    if (result.status === "stopped") {
      return { runId, status: "aborted", error: result.error ?? "stopped by user" };
    }
    return { runId, status: "failed", error: result.error ?? "loop failed" };
  }

  /** First-write-wins terminal settlement. Publishes the outcome, closes the
   *  event buffer, removes the live handle. Never overwrites a settled one. */
  function settle(runId: string, outcome: RunOutcomeResponse): void {
    if (outcomes.has(runId)) return;
    outcomes.set(runId, outcome);
    const active = activeRuns.get(runId);
    if (active) {
      active.settled = true;
      active.buffer.close();
      activeRuns.delete(runId);
    }
    const buf = eventBuffers.get(runId);
    if (buf) {
      buf.close();
      eventBuffers.delete(runId);
    }
  }

  async function runLoop(
    input: Parameters<CodingRunRegistry["execute"]>[0],
    active: ActiveRun,
  ): Promise<void> {
    const { runId } = input.run;
    let runtime: RunRuntime | null = null;
    try {
      runtime = opts.runtimeFactory
        ? await opts.runtimeFactory({
            workspaceRoot: input.workspace.root,
            workspaceAccess: input.workspace.access,
            runId,
            modelRuntime: opts.modelRuntime,
          })
        : await assembleRunRuntime({
            workspaceRoot: input.workspace.root,
            workspaceAccess: input.workspace.access,
            runId,
            modelRuntime: opts.modelRuntime,
            skillRoots: [],
          });
      if (active.settled || active.stopRequested) {
        // stop() landed before the loop started: accept (the caller already
        // saw accepted or will) and settle aborted without running.
        active.startResolve?.();
        active.startResolve = null;
        await runtime.close();
        settle(runId, { runId, status: "aborted", error: "stopped before start" });
        return;
      }
      active.runtime = runtime;
      // The Run's store is seeded with the full Product history + the current
      // input by the loop itself (buildLoopInput appends history + meta +
      // input atomically). Create the session root first.
      await runtime.store.create({
        sessionId: runId,
        backendKind: "coding_agent",
        workspaceRoot: input.workspace.root,
        leafEntryId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      runtime.session.onEvent((event) => {
        active.buffer.append({ type: event.type, data: event as never });
        if (event.type === "agent_start") {
          // The loop is live: steer/stop are now routable. Release execute().
          active.startResolve?.();
          active.startResolve = null;
        }
      });
      runtime.setActiveRun(input.run as AgentRunSnapshot<"coding_agent">);
      const result = await runtime.session.startLoop({
        history: input.history,
        input: input.input,
        run: input.run as AgentRunSnapshot<"coding_agent">,
        workspace: input.workspace,
        metadata: input.metadata,
      });
      settle(runId, mapLoopResult(result, runId));
    } catch (caught) {
      // Acceptance failed (assembly error): reject execute() so the caller
      // keeps the input undelivered. If the loop itself failed after start,
      // agent_start already released execute(); settle failed.
      const errObj = caught instanceof Error ? caught : new Error(String(caught));
      active.startReject?.(errObj);
      active.startReject = null;
      active.startResolve?.();
      active.startResolve = null;
      settle(runId, { runId, status: "failed", error: errObj.message });
    } finally {
      if (runtime) await runtime.close().catch(() => {});
    }
  }

  async function executeInner(
    input: Parameters<CodingRunRegistry["execute"]>[0],
  ): Promise<{ runId: string; accepted: boolean }> {
    const runId = input.run.runId;
    // Same runId + same payload: idempotent replay of the accepted result.
    // Same runId + different payload: conflict - a run identity is unique.
    const existing = executed.get(runId);
    if (existing) {
      if (existing.payloadHash !== hashPayload(input)) {
        throw err("conflict", `runId ${runId} already used with a different payload`);
      }
      return existing.result;
    }
    await validateModel(input.run.model.modelId);
    validateWorkspace(input.workspace.root);
    if (shuttingDown) throw err("conflict", "daemon shutting down");
    // Reserve the run BEFORE acceptance: steer/stop/events must be routable
    // the moment the caller sees accepted.
    const buffer = createRunEventBuffer(opts.eventBufferSize);
    eventBuffers.set(runId, buffer);
    let startResolve: (() => void) | null = null;
    let startReject: ((err: Error) => void) | null = null;
    const started = new Promise<void>((res, rej) => {
      startResolve = res;
      startReject = rej;
    });
    const active: ActiveRun = {
      runId,
      buffer,
      runtime: null,
      settled: false,
      stopRequested: false,
      startResolve,
      startReject,
    };
    activeRuns.set(runId, active);
    const result = { runId, accepted: true };
    executed.set(runId, { payloadHash: hashPayload(input), result });
    void runLoop(input, active);
    await started;
    return result;
  }

  const api: CodingRunRegistry = {
    async execute(input) {
      const runId = input.run.runId;
      const existing = inflight.get(runId);
      if (existing) return existing as Promise<{ runId: string; accepted: boolean }>;
      const p = executeInner(input).finally(() => {
        if (inflight.get(runId) === p) inflight.delete(runId);
      });
      inflight.set(runId, p);
      return p;
    },

    async steer(runId, input) {
      const active = activeRuns.get(runId);
      if (!active || active.settled) {
        throw err("conflict", `steer requires a live run: ${runId}`);
      }
      if (!active.runtime) {
        throw err("conflict", `steer requires a live run: ${runId} (not started)`);
      }
      try {
        active.runtime.session.steer(input);
      } catch (caught) {
        throw err(
          "conflict",
          `steer rejected by run ${runId}: ${caught instanceof Error ? caught.message : String(caught)}`,
        );
      }
    },

    async stop(runId) {
      const active = activeRuns.get(runId);
      if (!active || active.settled) return; // idempotent no-op
      active.stopRequested = true;
      active.runtime?.session.stop();
    },

    getEvents(runId) {
      const buf = eventBuffers.get(runId);
      if (!buf) throw err("not_found", `no event stream for run: ${runId}`);
      return buf;
    },

    hasRun(runId) {
      return eventBuffers.has(runId) || outcomes.has(runId) || activeRuns.has(runId);
    },

    getOutcome(runId) {
      return outcomes.get(runId) ?? null;
    },

    async shutdown() {
      shuttingDown = true;
      // Runs that never settled get a terminal failed outcome FIRST so an
      // active segment observes a terminal state, not just a closed stream.
      const live = [...activeRuns.values()];
      for (const active of live) {
        if (!active.settled) {
          active.stopRequested = true;
          settle(active.runId, { runId: active.runId, status: "failed", error: "daemon shutdown" });
        }
        active.runtime?.session.stop();
      }
      for (const b of eventBuffers.values()) b.close();
      eventBuffers.clear();
      await Promise.allSettled(live.map((a) => a.runtime?.close() ?? Promise.resolve()));
      activeRuns.clear();
    },
  };
  return api;
}
