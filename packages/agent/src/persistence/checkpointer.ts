/**
 * Checkpointer is the legacy composite interface combining message storage,
 * event logging, and interrupt state. Prefer the split interfaces directly:
 * {@link MessageStore}, {@link EventLog}, {@link InterruptStore}.
 *
 * This interface is retained so existing implementations (in-memory, sqlite,
 * file) continue to satisfy the type while callers migrate to the split fields
 * on AgentRuntime.
 */
import type { EventLog } from "./event-log.js";
import type { InterruptStore } from "./interrupt-store.js";
import type { MessageStore } from "./message-store.js";

// Re-export types that moved to the split interface files, for back-compat.
export type { CheckpointEvent, CheckpointEventRow } from "./event-log.js";
export type { InterruptState } from "./interrupt-store.js";
export { InterruptSignal } from "./interrupt-store.js";

export interface Checkpointer extends MessageStore, Partial<EventLog>, Partial<InterruptStore> {}

/**
 * Validate that optional EventLog and InterruptStore capabilities on a
 * Checkpointer are implemented in matched pairs (append/read, save/consume).
 * Throws if a capability is half-implemented.
 */
export function validateCheckpointer(cp: Checkpointer): void {
  const hasAppend = typeof cp.appendEvent === "function";
  const hasRead = typeof cp.readEvents === "function";
  if (hasAppend !== hasRead) {
    throw new Error(
      "Checkpointer event capability is partial: " +
        `appendEvent=${hasAppend}, readEvents=${hasRead}. ` +
        "Both must be implemented or both omitted.",
    );
  }
  const hasSaveInt = typeof cp.saveInterrupt === "function";
  const hasConsumeInt = typeof cp.consumeInterrupt === "function";
  if (hasSaveInt !== hasConsumeInt) {
    throw new Error(
      "Checkpointer interrupt capability is partial: " +
        `saveInterrupt=${hasSaveInt}, consumeInterrupt=${hasConsumeInt}. ` +
        "Both must be implemented or both omitted.",
    );
  }
}

/** Compose a Checkpointer from split interfaces. */
export function composeCheckpointer(
  messages: MessageStore,
  events?: EventLog,
  interrupts?: InterruptStore,
): Checkpointer {
  return {
    load: messages.load.bind(messages),
    save: messages.save.bind(messages),
    ...(messages.deleteThread ? { deleteThread: messages.deleteThread.bind(messages) } : {}),
    ...(events
      ? {
          appendEvent: events.appendEvent.bind(events),
          readEvents: events.readEvents.bind(events),
        }
      : {}),
    ...(interrupts
      ? {
          saveInterrupt: interrupts.saveInterrupt.bind(interrupts),
          consumeInterrupt: interrupts.consumeInterrupt.bind(interrupts),
        }
      : {}),
  };
}
