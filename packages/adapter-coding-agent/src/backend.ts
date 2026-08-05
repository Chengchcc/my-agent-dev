import type {
  AgentBackend,
  BackendEvent,
  BackendInputMessage,
  BackendRunInput,
  BackendRunOutcome,
  BackendRunSegment,
} from "@my-agent-team/agent-backend";
import type { CodingAgentClient } from "./client.js";
import { mapRunEvent, mapRunOutcome } from "./event-mapper.js";
import { type RunEventEnvelope, TransportError } from "./transport.js";

interface ActiveRun {
  readonly runId: string;
  readonly segment: BackendRunSegment<"coding_agent">;
  stop(): Promise<void>;
}

/** The Coding Agent adapter: one `execute()` = one daemon Run = one loop =
 *  one outcome. No session lifecycle, no resume; steer/stop target the
 *  runId directly. */
export class CodingAgentBackend implements AgentBackend<"coding_agent"> {
  readonly kind = "coding_agent" as const;
  private readonly client: CodingAgentClient;
  private readonly activeRuns = new Map<string, ActiveRun>();

  constructor(client: CodingAgentClient) {
    this.client = client;
  }

  async execute(
    input: BackendRunInput<"coding_agent">,
  ): Promise<BackendRunSegment<"coding_agent">> {
    const resp = await this.client.execute(input as never);
    return buildSegment(this.client, this.activeRuns, resp.runId);
  }

  async steer(runId: string, input: BackendInputMessage): Promise<void> {
    // Steer is an in-flight injection into the LIVE daemon run: the daemon
    // rejects it when the run is not live, so no local activeRuns lookup is
    // needed - the runId IS the target.
    await this.client.steer(runId, input as never);
  }

  async stop(runId: string): Promise<void> {
    const active = this.activeRuns.get(runId);
    if (active) await active.stop();
    else await this.client.stop(runId);
  }
}

function buildSegment(
  client: CodingAgentClient,
  activeRuns: Map<string, ActiveRun>,
  runId: string,
): BackendRunSegment<"coding_agent"> {
  let lastEventId: number | undefined;
  let stopped = false;
  let settled = false;

  const doStop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await client.stop(runId);
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
        if (code === "not_found") return; // run closed: stream is over
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
        // 404 = the run is unknown (daemon restart or closed). The run is
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
    if (activeRuns.get(runId) === active) {
      activeRuns.delete(runId);
    }
  });

  const segment: BackendRunSegment<"coding_agent"> = {
    events: eventStream(),
    outcome: outcomePromise,
    stop: doStop,
  };
  const active: ActiveRun = { runId, segment, stop: doStop };
  activeRuns.set(runId, active);
  return segment;
}

// Re-export so callers can construct the input message type explicitly.
export type { BackendInputMessage };
