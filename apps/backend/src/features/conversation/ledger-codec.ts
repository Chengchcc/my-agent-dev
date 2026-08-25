import { z } from "zod";

// ─── Ledger codec (backend-internal storage shape) ───────────────────
// 1:1 collapse (spec 2026-08-25): LedgerEntry is the conversation_ledger
// storage row, not a wire contract. The SSE boundary maps it to
// ConversationEvent (api-contract) before it leaves the backend.

export const LedgerKind = z.enum([
  "message",
  "member.joined",
  "member.left",
  "todo",
  "surface.control",
  "undo",
]);

export type LedgerKind = z.infer<typeof LedgerKind>;

export const LedgerEntry = z.object({
  seq: z.number(),
  conversationId: z.string(),
  senderMemberId: z.string(),
  addressedTo: z.array(z.string()).default([]),
  kind: LedgerKind,
  // Serialized string on the live push path; parsed object when read back
  // through the drizzle select schema. Callers normalize before use.
  content: z.unknown(),
  ts: z.number(),
  /** Soft-delete flag (fork/undo): logically removed, ledger stays append-only. */
  undone: z.boolean().optional(),
});

export type LedgerEntry = z.infer<typeof LedgerEntry>;
