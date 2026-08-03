import type {
  AgentBackend,
  AgentBackendCapabilities,
  BackendEvent,
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
import type { RunEventEnvelope } from "./transport.js";

/** Live session handle for the Coding Agent backend. Product Backend only
 *  sees the opaque backendSessionId via the base ref. */
export interface CodingAgentSessionRef extends BackendSessionRef<"coding_agent"> {
  readonly runId: string;
}

const CAPABILITIES: AgentBackendCapabilities = {
  persistentSession: true,
  nativeResume: true,
  nativeSteer: true,
  thinkingStream: false,
  productTools: "mcp",
  pendingActionResponse: false,
};

export class CodingAgentBackend implements AgentBackend<"coding_agent", CodingAgentSessionRef> {
  readonly kind = "coding_agent" as const;
  readonly capabilities = CAPABILITIES;
  private readonly client: CodingAgentClient;

  constructor(client: CodingAgentClient) {
    this.client = client;
  }

  async start(
    input: BackendStartInput<"coding_agent">,
  ): Promise<BackendSessionRun<"coding_agent", CodingAgentSessionRef>> {
    const resp = await this.client.startSession({
      idempotencyKey: `start-${input.run.runId}`,
      history: input.history as never,
      run: input.run as never,
      workspace: input.workspace,
      metadata: input.metadata,
    });
    const ref: CodingAgentSessionRef = {
      backendSessionId: resp.backendSessionId,
      backendKind: "coding_agent",
      runId: resp.runId,
    };
    return {
      session: ref,
      segment: buildSegment(this.client, ref),
    };
  }

  async send(
    session: CodingAgentSessionRef,
    input: BackendRunInput<"coding_agent">,
  ): Promise<BackendRunSegment<"coding_agent">> {
    // steer routes through send(mode: "steer") — no separate method
    await this.client.sendRun(session.backendSessionId, {
      idempotencyKey: `send-${input.run.runId}-${input.mode}`,
      commandId: `cmd-${Date.now()}-${input.mode}`,
      messages: input.messages as never,
      run: input.run as never,
      mode: input.mode,
      promptText: "[prompt]",
      metadata: input.metadata,
    });
    return buildSegment(this.client, { ...session, runId: input.run.runId });
  }

  async resume(
    backendSessionId: string,
    input: BackendStartInput<"coding_agent">,
  ): Promise<BackendSessionRun<"coding_agent", CodingAgentSessionRef>> {
    const resp = await this.client.resumeSession({
      idempotencyKey: `resume-${input.run.runId}`,
      history: input.history as never,
      run: input.run as never,
      workspace: input.workspace,
      metadata: input.metadata,
    });
    const ref: CodingAgentSessionRef = {
      backendSessionId,
      backendKind: "coding_agent",
      runId: resp.runId,
    };
    return {
      session: ref,
      segment: buildSegment(this.client, ref),
    };
  }

  async respond(
    _session: CodingAgentSessionRef,
    _action: PendingActionResponse,
  ): Promise<BackendRunSegment<"coding_agent">> {
    // pendingActionResponse=false: respond is unsupported, no HTTP call
    throw new Error("coding_agent backend does not support pending action responses");
  }

  async stop(session: CodingAgentSessionRef): Promise<void> {
    await this.client.stopSession(session.backendSessionId);
  }

  async close(session: CodingAgentSessionRef): Promise<void> {
    await this.client.closeSession(session.backendSessionId);
  }
}

function buildSegment(
  client: CodingAgentClient,
  ref: CodingAgentSessionRef,
): BackendRunSegment<"coding_agent"> {
  const runId = ref.runId;
  let lastEventId: number | undefined;

  async function* eventStream(): AsyncIterable<BackendEvent<"coding_agent">> {
    for await (const envelope of client.streamEvents(runId, lastEventId)) {
      lastEventId = envelope.id;
      yield mapRunEvent(envelope as unknown as RunEventEnvelope);
    }
  }

  const outcomePromise = (async (): Promise<BackendRunOutcome> => {
    for (;;) {
      const outcome = await client.getOutcome(runId);
      if (outcome) return mapRunOutcome(outcome);
      await new Promise((r) => setTimeout(r, 200));
    }
  })();

  return {
    events: eventStream(),
    outcome: outcomePromise,
    stop: async () => {
      await client.stopSession(ref.backendSessionId);
    },
  };
}
