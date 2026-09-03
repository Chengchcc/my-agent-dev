import type { BackendEvent, BackendRunSegment } from "@chengchenccc/agent-contract";
import { TELEMETRY_EVENT_TYPES } from "./execution-input.js";

export interface LiveEventBus {
  /** Broadcast a transient event to current-process subscribers and the
   *  durable telemetry sink (best-effort). */
  broadcast(runId: string, event: BackendEvent): void;
  closeSubscribers(runId: string): void;
  /** Fan out the segment's event stream. Resolves when fully drained. */
  forwardEvents(runId: string, segment: BackendRunSegment): Promise<void>;
  subscribe(runId: string, signal?: AbortSignal): AsyncIterable<BackendEvent>;
}

export function createLiveEventBus(deps: {
  persistRunEvent?: (runId: string, event: BackendEvent) => Promise<void>;
}): LiveEventBus {
  const subscribers = new Map<string, Set<(e: BackendEvent) => void>>();

  function broadcast(runId: string, event: BackendEvent): void {
    // Durable telemetry: persist the normalized event log (tool calls,
    // status, workflow steps). Transient text/thinking deltas are skipped.
    if (deps.persistRunEvent && TELEMETRY_EVENT_TYPES.has(event.type)) {
      void deps.persistRunEvent(runId, event).catch(() => {
        /* telemetry is best-effort */
      });
    }
    const set = subscribers.get(runId);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(event);
      } catch {
        /* subscriber failure never affects the run */
      }
    }
  }

  function closeSubscribers(runId: string): void {
    subscribers.delete(runId);
  }

  /** Transient live-update fan-out: events from the run's segment are
   *  broadcast to current-process subscribers. Never persisted; subscriber
   *  failure never affects the run; the stream ends when the run settles. */
  function forwardEvents(runId: string, segment: BackendRunSegment): Promise<void> {
    return (async () => {
      try {
        for await (const ev of segment.events) broadcast(runId, ev);
      } catch {
        /* event stream closing is not a run failure */
      }
    })();
  }

  function subscribe(runId: string, signal?: AbortSignal): AsyncIterable<BackendEvent> {
    return (async function* () {
      const pending: BackendEvent[] = [];
      const fn = (e: BackendEvent): void => {
        pending.push(e);
      };
      let set = subscribers.get(runId);
      if (!set) {
        set = new Set();
        subscribers.set(runId, set);
      }
      set.add(fn);
      try {
        // Drain `pending` even after closeSubscribers: a yield suspends
        // this generator, so the subscriber set can close while buffered
        // events are still unyielded. All broadcasts happen before the
        // close (the dispatch drain race orders them), so pending is
        // complete by then - never drop the tail.
        while (pending.length > 0 || subscribers.has(runId)) {
          if (signal?.aborted) break;
          if (pending.length > 0) {
            yield pending.shift()!;
            continue;
          }
          await new Promise((r) => setTimeout(r, 20));
        }
      } finally {
        set.delete(fn);
        if (set.size === 0) subscribers.delete(runId);
      }
    })();
  }

  return { broadcast, closeSubscribers, forwardEvents, subscribe };
}
