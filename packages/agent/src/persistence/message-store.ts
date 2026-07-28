import type { Message } from "@my-agent-team/message";

/** 消息存储 -- session 职责，纯消息持久化。 */
export interface MessageStore {
  /** @param sessionId - persistent memory line key */
  load(sessionId: string): Promise<Message[] | null>;
  save(sessionId: string, messages: readonly Message[]): Promise<void>;
  /** Delete all data for a thread. Idempotent - no-op if thread doesn't exist. */
  deleteThread?(sessionId: string): Promise<void>;
}
