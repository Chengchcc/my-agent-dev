import type { LedgerEntry, LedgerKind, Member } from "@my-agent-team/conversation";

// Re-export canonical types from @my-agent-team/conversation
export type { LedgerKind };

export interface ConversationRow {
  conversationId: string;
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
}

export interface MemberRow {
  memberId: string;
  conversationId: string;
  /** M17.5: Derived from canonical Member.kind (agent|human). */
  kind: Member["kind"];
  agentId: string | null;
  userRef: string | null;
  displayName: string | null;
  joinedAt: number;
}

// M17.5: LedgerEntry is imported from the canonical @my-agent-team/conversation
// package (single ontology). spanId was added to the canonical LedgerEntry schema.
export type { LedgerEntry };

export interface CreateConversationInput {
  conversationId: string;
  triggerMode?: string;
  origin?: string;
  createdAt: number;
  /** Fork provenance: source conversation id (set when origin='fork'). */
  forkSource?: string | null;
  /** Fork provenance: source ledger seq the fork was cut from. */
  forkFromSeq?: number | null;
}

export interface CreateMemberInput {
  memberId: string;
  conversationId: string;
  kind: "agent" | "human";
  agentId?: string | null;
  userRef?: string | null;
  displayName?: string | null;
  joinedAt: number;
}

export interface AppendLedgerInput {
  conversationId: string;
  senderMemberId: string;
  addressedTo?: string[];
  kind: LedgerKind;
  content: string; // JSON-encoded
  ts: number;
  /** Optional: run ID for dedup (incremental projection). */
  spanId?: string;
}

export interface ConversationWithMembers {
  conversationId: string;
  triggerMode: string;
  hopCount: number;
  createdAt: number;
  title: string | null;
  /** Fork provenance: source conversation id when this conversation is a fork, else null. */
  forkSource: string | null;
  members: MemberRow[];
  /** Last ledger entry timestamp; null when the conversation has no messages yet. */
  lastActivityAt: number | null;
}

export interface ConversationPort {
  createConversation(input: CreateConversationInput): ConversationRow;
  getConversation(conversationId: string): ConversationRow | null;
  setConversationTitle(conversationId: string, title: string): void;
  updateHopCount(conversationId: string, count: number): void;
  listConversations(): ConversationWithMembers[];
  listConversationsByAgent(agentId: string): ConversationWithMembers[];
  deleteConversation(conversationId: string): boolean;
  /** Last ledger entry timestamp for a conversation, or null when empty. */
  getLastActivityAt?(conversationId: string): number | null;

  addMember(input: CreateMemberInput): { member: MemberRow; created: boolean };
  getMembers(conversationId: string): MemberRow[];
  getAgentMembers(conversationId: string): MemberRow[];
  removeMember(conversationId: string, memberId: string): boolean;

  appendLedgerEntry(input: AppendLedgerInput): number; // returns seq
  getLedgerEntries(conversationId: string, opts?: { sinceSeq?: number }): LedgerEntry[];
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
