import { z } from "zod";

// ─── LedgerKind — single source of truth for entry kind ──

export const LedgerKind = z.enum([
  "message",
  "member.joined",
  "member.left",
  "todo",
  "surface.control",
  "undo",
]);

/** Type-level LedgerKind — use this for type annotations.
 *  The zod const is the runtime validator; this is the type alias. */
export type LedgerKind = z.infer<typeof LedgerKind>;

// ─── LedgerEntry ────────────────────────────────────────────

export const LedgerEntry = z.object({
  seq: z.number(),
  conversationId: z.string(),
  senderMemberId: z.string(),
  addressedTo: z.array(z.string()).default([]),
  kind: LedgerKind,
  // content is always a serialized string (JSON.stringify for structured payloads).
  // Message entries use serializeMessageRevision; other kinds use JSON.stringify.
  // undo entries use JSON.stringify({ undoneSeqs: number[] }).
  content: z.string(),
  ts: z.number(),
  /** Soft-delete flag (fork/undo): when true the entry is logically removed from the
   *  conversation but the ledger stays append-only. Absent on entries written before
   *  migration 0011 and on entries that are still live. */
  undone: z.boolean().optional(),
});

export type LedgerEntry = z.infer<typeof LedgerEntry>;

/** Parse a ledger entry from wire/SSE, throwing on invalid shape. */
export function parseLedgerEntry(raw: unknown): LedgerEntry {
  return LedgerEntry.parse(raw);
}

/** Safe-parse a ledger entry (returns success/error instead of throwing). */
export function safeParseLedgerEntry(raw: unknown): z.SafeParseReturnType<unknown, LedgerEntry> {
  return LedgerEntry.safeParse(raw);
}

/** Serialize a ledger entry to JSON. */
export function serializeLedgerEntry(e: LedgerEntry): string {
  return JSON.stringify(LedgerEntry.parse(e));
}
