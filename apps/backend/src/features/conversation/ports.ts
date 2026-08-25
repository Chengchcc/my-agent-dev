import type { LedgerEntry, LedgerKind } from "./ledger-codec.js";

// Ledger codec is backend-internal (1:1 collapse, spec 2026-08-25).
export type { LedgerEntry, LedgerKind };

export interface ConversationRow {
  conversationId: string;
  /** The conversation's agent (1:1 collapse). Nullable on legacy rows. */
  agentId: string | null;
  triggerMode: string;
  hopCount: number;
  createdAt: number;
  title: string | null;
  /** M19: Origin - 'user' for user chats, 'issue' for issue-side conversations. */
  origin: string;
  /** Fork provenance: source conversation id when origin='fork', else null. */
  forkSource: string | null;
  /** Fork provenance: source ledger seq the fork was cut from, else null. */
  forkFromSeq: number | null;
  /** Project binding (ADR 0023): runs use the project worktree as cwd. */
  projectId: string | null;
}

export interface CreateConversationInput {
  conversationId: string;
  /** The conversation's agent (required for new conversations). */
  agentId?: string | null;
  triggerMode?: string;
  origin?: string;
  createdAt: number;
  /** Fork provenance: source conversation id (set when origin='fork'). */
  forkSource?: string | null;
  /** Fork provenance: source ledger seq the fork was cut from. */
  forkFromSeq?: number | null;
  projectId?: string | null;
}

export interface AppendLedgerInput {
  conversationId: string;
  senderMemberId: string;
  addressedTo?: string[];
  kind: LedgerKind;
  content: string; // JSON-encoded
  ts: number;
}

/** List projection — no members (1:1: the agent is ConversationRow.agentId). */
export interface ConversationSummary extends ConversationRow {
  /** Last ledger entry timestamp; null when the conversation has no messages yet. */
  lastActivityAt: number | null;
  lastMessagePreview: string | null;
}

export interface ConversationPort {
  createConversation(input: CreateConversationInput): ConversationRow;
  deleteConversation(conversationId: string): Promise<boolean>;
  getConversation(conversationId: string): ConversationRow | null;
  setConversationTitle(conversationId: string, title: string): void;
  updateHopCount(conversationId: string, count: number): void;
  listConversations(): ConversationSummary[];
  /** C2: any conversation bound to this project (delete guard). */
  hasProjectBinding?(projectId: string): boolean;
  listConversationsByAgent(agentId: string): ConversationSummary[];
  getLastMessagePreview?(conversationId: string): string | null;
  getLastActivityAt?(conversationId: string): number | null;

  appendLedgerEntry(input: AppendLedgerInput): number; // returns seq
  getLedgerEntries(conversationId: string, opts?: { sinceSeq?: number }): LedgerEntry[];
  /** Exact ledger lookup by (conversationId, seq) — the precise-reference
   *  path for LedgerMessageResolver; never a cursor scan. */
  getLedgerEntry(conversationId: string, seq: number): LedgerEntry | null;
  /** Mark a ledger entry as undone (soft delete). */
  markLedgerEntryUndone?(conversationId: string, seq: number): void;
  /** Get fork source metadata for a conversation. */
  getForkSource?(conversationId: string): { source: string; fromSeq: number } | null;
  /** Keyword search across all conversation ledger content. */
  searchLedger(
    keyword: string,
    limit?: number,
  ): Array<{
    conversationId: string;
    seq: number;
    snippet: string;
    ts: number;
    senderName: string;
    conversationTitle: string | null;
  }>;
}
