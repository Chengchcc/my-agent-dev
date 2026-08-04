import type {
  AgentBackend,
  AgentBackendCapabilities,
  BackendEvent,
  BackendInputMessage,
  BackendRunInput,
  BackendRunOutcome,
  BackendRunSegment,
  BackendSessionRef,
  BackendSessionRun,
  BackendStartInput,
  PendingActionResponse,
} from "@my-agent-team/agent-backend";
import type { CodingAgentClient } from "./client.js";
import { mapRunEvent, mapRunOutcome } from "./event-mapper.js";
import { type RunEventEnvelope, TransportError } from "./transport.js";

/** The adapter's session ref is the plain contract identity only -
 *  `{ backendSessionId, backendKind }`. Run identity is segment-internal and
 *  tracked in the adapter's live registry, never on the public ref. */
export type CodingAgentSessionRef = BackendSessionRef<"coding_agent">;

const CAPABILITIES: AgentBackendCapabilities = {
  persistentSession: true,
  nativeResume: true,
  nativeSteer: true,
  thinkingStream: false,
  productTools: "mcp",
  pendingActionResponse: false,
};

interface ActiveRun {
  readonly runId: string;
  /** The ORIGINAL segment object for the run - steer returns this exact
   *  object so callers observe one stream, one outcome, one stop state. */
  readonly segment: BackendRunSegment<"coding_agent">;
  stop(): Promise<void>;
}

export class CodingAgentBackend implements AgentBackend<"coding_agent", CodingAgentSessionRef> {
  readonly kind = "coding_agent" as const;
  readonly capabilities = CAPABILITIES;
  private readonly client: CodingAgentClient;
  /** backendSessionId -> currently active run segment. Lets stop(session) -
   *  which carries only the ref - target the active run without leaking runId
   *  onto the public SessionRef. */
  private readonly activeRuns = new Map<string, ActiveRun>();

  constructor(client: CodingAgentClient) {
    this.client = client;
  }

  async start(
    input: BackendStartInput<"coding_agent">,
  ): Promise<BackendSessionRun<"coding_agent", CodingAgentSessionRef>> {
    const resp = await this.client.startSession({
      // Idempotency source is the durable input id, never a clock or runId.
      idempotencyKey: input.input.inputId,
      history: input.history as never,
      input: input.input as never,
      run: input.run as never,
      workspace: input.workspace,
      metadata: input.metadata,
    });
    const ref: CodingAgentSessionRef = {
      backendSessionId: resp.backendSessionId,
      backendKind: "coding_agent",
    };
    return { session: ref, segment: buildSegment(this.client, this.activeRuns, ref, resp.runId) };
  }

  async send(
    session: CodingAgentSessionRef,
    input: BackendRunInput<"coding_agent">,
  ): Promise<BackendRunSegment<"coding_agent">> {
    // Steer routes through send(mode: "steer") - no separate method, no new
    // run segment (the active run's segment keeps streaming). The daemon
    // rejects a steer naming a different run, so the adapter targets the
    // active runId, never the input's (which may be a fresh id).
    if (input.mode === "steer") {
      const active = this.activeRuns.get(session.backendSessionId);
      if (active) {
        await this.client.sendRun(session.backendSessionId, {
          idempotencyKey: input.input.inputId,
          commandId: input.input.inputId,
          history: input.history as never,
          input: input.input as never,
          run: { ...input.run, runId: active.runId } as never,
          mode: "steer",
          metadata: input.metadata,
        });
        // Steer is an in-flight injection into the active run - it has no
        // terminal outcome of its own. Return the SAME segment object the
        // caller already holds (one stream, one outcome, one stop state).
        return active.segment;
      }
      // No active run: steer was rejected daemon-side; surface a settled
      // failed segment so the caller never treats steer as a completion.
      return {
        events: (async function* () {})(),
        outcome: Promise.resolve({
          status: "failed",
          error: "steer requires an active run",
        } as BackendRunOutcome),
        stop: async () => {},
      };
    }
    await this.client.sendRun(session.backendSessionId, {
      idempotencyKey: input.input.inputId,
      commandId: input.input.inputId,
      history: input.history as never,
      input: input.input as never,
      run: input.run as never,
      mode: input.mode,
      metadata: input.metadata,
    });
    return buildSegment(this.client, this.activeRuns, session, input.run.runId);
  }

  async resume(
    backendSessionId: string,
    input: BackendStartInput<"coding_agent">,
  ): Promise<BackendSessionRun<"coding_agent", CodingAgentSessionRef>> {
    const resp = await this.client.resumeSession(backendSessionId, {
      idempotencyKey: input.input.inputId,
      history: input.history as never,
      input: input.input as never,
      run: input.run as never,
      workspace: input.workspace,
      metadata: input.metadata,
    });
    const ref: CodingAgentSessionRef = { backendSessionId, backendKind: "coding_agent" };
    return { session: ref, segment: buildSegment(this.client, this.activeRuns, ref, resp.runId) };
  }

  async respond(
    _session: CodingAgentSessionRef,
    _action: PendingActionResponse,
  ): Promise<BackendRunSegment<"coding_agent">> {
    // pendingActionResponse=false: respond is unsupported, no HTTP call.
    throw new Error("coding_agent backend does not support pending action responses");
  }

  async stop(session: CodingAgentSessionRef): Promise<void> {
    const active = this.activeRuns.get(session.backendSessionId);
    if (active) await active.stop();
    else await this.client.stopSession(session.backendSessionId);
  }

  async close(session: CodingAgentSessionRef): Promise<void> {
    await this.client.closeSession(session.backendSessionId);
    this.activeRuns.delete(session.backendSessionId);
  }
}

function buildSegment(
  client: CodingAgentClient,
  activeRuns: Map<string, ActiveRun>,
  ref: CodingAgentSessionRef,
  runId: string,
): BackendRunSegment<"coding_agent"> {
  let lastEventId: number | undefined;
  let stopped = false;
  let settled = false;

  const doStop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await client.stopSession(ref.backendSessionId, runId);
  };

  async function* eventStream(): AsyncIterable<BackendEvent<"coding_agent">> {
    // Reconnect by lastEventId if the SSE connection drops before the run
    // settles. A replay_window_exceeded error is unrecoverable (events lost);
    // a normal end-of-stream mid-run means the connection dropped, so resume.
    for (;;) {
      try {
        for await (const envelope of client.streamEvents(runId, lastEventId)) {
          lastEventId = envelope.id;
          yield mapRunEvent(envelope as unknown as RunEventEnvelope);
        }
        if (settled) return;
        await new Promise((r) => setTimeout(r, 200));
      } catch (err) {
        const code = (err as { code?: string })?.code;
        if (code === "replay_window_exceeded") throw err;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }

  const outcomePromise = (async (): Promise<BackendRunOutcome> => {
    for (;;) {
      try {
        const outcome = await client.getOutcome(runId);
        if (outcome) return mapRunOutcome(outcome);
      } catch (err) {
        // 404 = the session/run was closed while we were polling. The run is
        // gone: settle as failed instead of polling a phantom forever (and
        // never leak an unhandled rejection to concurrent consumers).
        if (err instanceof TransportError && err.code === "not_found") {
          return { status: "failed", error: "run closed before outcome" };
        }
        throw err;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  })().finally(() => {
    settled = true;
    if (activeRuns.get(ref.backendSessionId) === active) {
      activeRuns.delete(ref.backendSessionId);
    }
  });

  const segment: BackendRunSegment<"coding_agent"> = {
    events: eventStream(),
    outcome: outcomePromise,
    stop: doStop,
  };
  const active: ActiveRun = { runId, segment, stop: doStop };
  activeRuns.set(ref.backendSessionId, active);
  return segment;
}

// Re-export so callers can construct the input message type explicitly.
export type { BackendInputMessage };
