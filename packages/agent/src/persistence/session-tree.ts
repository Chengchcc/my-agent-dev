import type { Message } from "@my-agent-team/message";

export interface SessionTreeEntryBase {
  id: string;
  parentId: string | null;
  timestamp: number;
}

export interface MessageEntry extends SessionTreeEntryBase {
  type: "message";
  message: Message;
}

export interface CompactionEntry extends SessionTreeEntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

export interface ModelChangeEntry extends SessionTreeEntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}

export type SessionTreeEntry = MessageEntry | CompactionEntry | ModelChangeEntry;

export interface SessionContext {
  messages: Message[];
  model?: { provider: string; modelId: string };
}
