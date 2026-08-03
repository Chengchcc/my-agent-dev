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
  oldestRetainedId(): number | null;
  lastId(): number;
  close(): void;
}

export function createRunEventBuffer(size: number): RunEventBuffer {
  const buffer: BufferedEvent[] = [];
  const subscribers = new Set<(event: BufferedEvent) => void>();
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
          /* subscriber errors must not break the run */
        }
      }
      return id;
    },

    subscribeAfter(lastEventId, sink) {
      // Replay strictly after lastEventId from retained history
      const firstRetained = buffer[0];
      if (firstRetained && lastEventId < firstRetained.id) {
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

    oldestRetainedId() {
      return buffer[0]?.id ?? null;
    },

    lastId() {
      return nextId - 1;
    },

    close() {
      closed = true;
      subscribers.clear();
    },
  };
}
