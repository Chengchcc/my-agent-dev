import type { ContentBlock } from "./content-block.js";

export type MessageRole = "system" | "user" | "assistant" | "tool";

export type MessageState = "pending" | "streaming" | "waiting" | "done" | "error";

/** Message-level authorship role — who generated this message.
 *  Distinct from conversation Member (who participates in the conversation).
 *  - "system": system-generated messages (hop caps, lifecycle events)
 *  - "user": human user sent this message
 *  - "agent": an agent model produced this message
 *  - "tool": a tool execution produced this content
 *  Conversation Member.kind is "agent" | "human" — a different layer (participation, not authorship). */
export interface MessageAuthor {
  kind: "system" | "user" | "agent" | "tool";
  id?: string;
  displayName?: string;
}

export interface MessageToolState {
  id: string;
  name: string;
  state: "running" | "done" | "error";
  isError?: boolean;
}

export interface MessageError {
  code?: string;
  message: string;
}

export interface Message {
  id?: string;
  role: MessageRole;
  author?: MessageAuthor;
  state?: MessageState;
  text?: string;
  blocks?: ContentBlock[];
  tools?: MessageToolState[];
  conversationId?: string;
  visibility?: "internal" | "conversation";
  createdAt?: number;
  updatedAt?: number;
  error?: MessageError;
  /** Transient run status indicator (retrying/compacting). Not persisted. */
  runStatus?: "running" | "retrying" | "compacting" | "waiting";
}
