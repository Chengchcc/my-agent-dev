import type { ContentBlock } from "./content-block.js";
import type { MessageError, MessageRole, MessageState, MessageToolState } from "./message.js";

export interface MessageRevision {
  messageId: string;
  state: MessageState;
  role: MessageRole;
  text?: string;
  blocks?: ContentBlock[];
  tools?: MessageToolState[];
  conversationId?: string;
  visibility?: "internal" | "conversation";
  updatedAt: number;
  error?: MessageError;
  /** Transient run status indicator (retrying/compacting). Not persisted to ledger. */
  runStatus?: "running" | "retrying" | "compacting" | "waiting";
}
