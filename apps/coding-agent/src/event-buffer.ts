/** Per-run bounded monotonic event replay buffer for SSE. Events are
 *  observation only — never the terminal authority and never the run owner. */

export interface BufferedEvent {
  readonly id: number;
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export class ReplayWindowExceededError extends Error {
  constructor(requestedId: number, oldestRetainedId: number) {
    super(`replay window exceeded: requested ${requestedId}, oldest retained ${oldestRetainedId}`);
    this.name = "ReplayWindowExceededError";
  }
}

export interface RunEventBuffer {
  append(event: Omit<BufferedEvent, "id">): number;
  subscribeAfter(lastEventId: number, sink: (event: BufferedEvent) => void): () => void;
  /** Register a callback fired once when the buffer closes (run settled), so
   *  open SSE streams can end instead of waiting on heartbeats forever. */
  onClose(cb: () => void): () => void;
  oldestRetainedId(): number | null;
  lastId(): number;
  close(): void;
}

export function createRunEventBuffer(size: number): RunEventBuffer {
  const buffer: BufferedEvent[] = [];
  const subscribers = new Set<(event: BufferedEvent) => void>();
  const closeCallbacks = new Set<() => void>();
  let nextId = 0;
  let closed = false;
  return {
    append(event) {
      if (closed) return nextId;
      const id = nextId++;
      buffer.push({ id, ...event });
      if (buffer.length > size) buffer.shift();
      for (const sink of subscribers) {
        try {
          sink({ id, ...event });
        } catch {
          // A throwing sink is either errored or a slow subscriber the route
          // is evicting (desiredSize bound). Remove it so the run is unaffected.
          subscribers.delete(sink);
        }
      }
      return id;
    },

    subscribeAfter(lastEventId, sink) {
      // Replay strictly after lastEventId from retained history. A reconnect
      // claiming an id older than the retained window has missed evicted
      // events => 409. Fresh clients (-1) replay from the oldest retained.
      const firstRetained = buffer[0];
      if (firstRetained && lastEventId >= 0 && lastEventId < firstRetained.id) {
        throw new ReplayWindowExceededError(lastEventId, firstRetained.id);
      }
      for (const event of buffer) {
        if (event.id > lastEventId) {
          try {
            sink(event);
          } catch {
            /* ignore */
          }
        }
      }
      subscribers.add(sink);
      return () => {
        subscribers.delete(sink);
      };
    },

    onClose(cb) {
      if (closed) {
        cb();
        return () => {};
      }
      closeCallbacks.add(cb);
      return () => {
        closeCallbacks.delete(cb);
      };
    },

    oldestRetainedId() {
      return buffer[0]?.id ?? null;
    },

    lastId() {
      return nextId - 1;
    },

    close() {
      closed = true;
      subscribers.clear();
      for (const cb of closeCallbacks) {
        try {
          cb();
        } catch {
          /* a closing callback must not break other subscribers */
        }
      }
      closeCallbacks.clear();
    },
  };
}
