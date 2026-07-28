import type { ChatModel } from "@my-agent-team/core";
import type { Message } from "@my-agent-team/message";
import type { Logger } from "../runtime/logger.js";
import type { Session } from "../persistence/session.js";

/** Marks index ranges in a Message[] that must not be dropped by shape(). */
export interface PreserveHint {
  /** Zero or more index ranges [start, end) that are mandatory.
   *  e.g. [{ start: 0, end: 1 }, { start: 5, end: 7 }] means messages
   *  at indices 0, 5, 6 are preserved. */
  ranges: Array<{ start: number; end: number }>;
}

export interface ContextManagerContext {
  sessionId: string;
  signal?: AbortSignal;
  logger: Logger;
  model: ChatModel;
  /** Optional hint marking message indices that must survive shaping. */
  preserve?: PreserveHint;
  /** Session for reversible compaction. Present when the agent has a session. */
  session?: Session;
}

export interface ContextManager {
  shape(ctx: ContextManagerContext, messages: readonly Message[]): Message[] | Promise<Message[]>;
}

export function pipeContextManagers(...managers: ContextManager[]): ContextManager {
  return {
    async shape(ctx, messages) {
      let current = [...messages];
      for (const m of managers) {
        current = await m.shape(ctx, current);
      }
      return current;
    },
  };
}
