import type { Database } from "bun:sqlite";
import { and, desc, eq, gt, inArray, isNotNull, like, notInArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/schema.js";
import { ConflictError } from "../../infra/domain-errors.js";
import type {
  AppendLedgerInput,
  ConversationPort,
  ConversationRow,
  ConversationWithMembers,
  CreateConversationInput,
  CreateMemberInput,
  LedgerEntry,
  MemberRow,
} from "./ports.js";

export function sqliteConversationAdapter(db: Database): ConversationPort {
  const d = drizzle(db, { schema, casing: "snake_case" });
  /** Last ledger entry timestamp for a conversation, or null if it has no messages. */
  const lastLedgerTs = (conversationId: string): number | null => {
    const row = d
      .select({ max: sql<number | null>`MAX(${schema.conversationLedger.ts})` })
      .from(schema.conversationLedger)
      .where(eq(schema.conversationLedger.conversationId, conversationId))
      .get();
    return row?.max ?? null;
  };

  return {
    // ─── Conversation ──────────────────────────────

    createConversation(input: CreateConversationInput): ConversationRow {
      const row = d
        .insert(schema.conversation)
        .values({
          conversationId: input.conversationId,
          triggerMode: input.triggerMode ?? "mention",
          hopCount: 0,
          origin: input.origin ?? "user",
          createdAt: input.createdAt,
          forkSource: input.forkSource ?? null,
          forkFromSeq: input.forkFromSeq ?? null,
        })
        .returning()
        .get();
      return schema.conversationSelectSchema.parse(row);
    },

    getConversation(conversationId: string): ConversationRow | null {
      const row = d
        .select()
        .from(schema.conversation)
        .where(eq(schema.conversation.conversationId, conversationId))
        .get();
      if (!row) return null;
      return schema.conversationSelectSchema.parse(row);
    },

    setConversationTitle(conversationId: string, title: string): void {
      d.update(schema.conversation)
        .set({ title })
        .where(eq(schema.conversation.conversationId, conversationId))
        .run();
    },

    updateHopCount(conversationId: string, count: number): void {
      d.update(schema.conversation)
        .set({ hopCount: count })
        .where(eq(schema.conversation.conversationId, conversationId))
        .run();
    },

    listConversations(): ConversationWithMembers[] {
      const convs = d
        .select()
        .from(schema.conversation)
        .where(inArray(schema.conversation.origin, ["user", "fork"]))
        .orderBy(desc(schema.conversation.createdAt))
        .all();
      // N+1: members fetched per conversation - kept as-is for behavior equivalence.
      // Performance optimization (join/batch) deferred to a separate PR.
      return convs.map((c) => ({
        ...schema.conversationSelectSchema.parse(c),
        members: d
          .select()
          .from(schema.member)
          .where(eq(schema.member.conversationId, c.conversationId))
          .all()
          .map((m) => schema.memberSelectSchema.parse(m) as MemberRow),
        lastActivityAt: lastLedgerTs(c.conversationId),
      }));
    },

    async deleteConversation(conversationId: string): Promise<boolean> {
      // Context entries form a self-referencing chain (parent_id → entry_id
      // with the default RESTRICT action), so the FK cascade from
      // conversation → agent_context_tree → agent_context_entry fails
      // mid-chain once a linear context has 2+ entries. Delete the entries
      // per-tree first (one DELETE per tree removes the whole chain in a
      // single statement, which SQLite FK checks atomically), then the
      // conversation — all inside one transaction.
      const active = d
        .select({ runId: schema.agentRun.runId })
        .from(schema.agentRun)
        .where(
          and(
            eq(schema.agentRun.conversationId, conversationId),
            inArray(schema.agentRun.status, ["running", "waiting", "commit_failed"]),
          ),
        )
        .get();
      if (active) {
        throw new ConflictError("Conversation has an active run; stop it before deleting.");
      }
      return d.transaction((tx) => {
        const trees = tx
          .select({ treeId: schema.agentContextTree.treeId })
          .from(schema.agentContextTree)
          .where(eq(schema.agentContextTree.conversationId, conversationId))
          .all();
        for (const { treeId } of trees) {
          // parent_id → entry_id is ON DELETE RESTRICT (drizzle default), so
          // SQLite aborts the moment a deleted row still has a child — even
          // inside a single DELETE covering the whole chain. Remove leaf rows
          // first, repeatedly, until the chain is empty (one pass per depth).
          const children = tx
            .selectDistinct({ parentId: schema.agentContextEntry.parentId })
            .from(schema.agentContextEntry)
            .where(
              and(
                eq(schema.agentContextEntry.treeId, treeId),
                isNotNull(schema.agentContextEntry.parentId),
              ),
            );
          // drizzle types run() as void, so terminate the loop by checking
          // whether any entry remains.
          for (;;) {
            tx.delete(schema.agentContextEntry)
              .where(
                and(
                  eq(schema.agentContextEntry.treeId, treeId),
                  notInArray(schema.agentContextEntry.entryId, children),
                ),
              )
              .run();
            const left = tx
              .select({ id: schema.agentContextEntry.entryId })
              .from(schema.agentContextEntry)
              .where(eq(schema.agentContextEntry.treeId, treeId))
              .limit(1)
              .get();
            if (!left) break;
          }
        }
        const deleted = tx
          .delete(schema.conversation)
          .where(eq(schema.conversation.conversationId, conversationId))
          .returning()
          .get();
        return Boolean(deleted);
      });
    },

    listConversationsByAgent(agentId: string): ConversationWithMembers[] {
      const memberRows = d
        .selectDistinct({ conversationId: schema.member.conversationId })
        .from(schema.member)
        .where(eq(schema.member.agentId, agentId))
        .all();
      // N+1: conversations and members fetched per conversation - kept as-is.
      return memberRows
        .map((mr) => {
          const c = d
            .select()
            .from(schema.conversation)
            .where(eq(schema.conversation.conversationId, mr.conversationId))
            .get();
          if (!c) return null;
          return {
            ...schema.conversationSelectSchema.parse(c),
            members: d
              .select()
              .from(schema.member)
              .where(eq(schema.member.conversationId, c.conversationId))
              .all()
              .map((m) => schema.memberSelectSchema.parse(m) as MemberRow),
            lastActivityAt: lastLedgerTs(c.conversationId),
          };
        })
        .filter(Boolean) as ConversationWithMembers[];
    },
    getLastActivityAt(conversationId: string): number | null {
      return lastLedgerTs(conversationId);
    },
    // ─── Member ────────────────────────────────────

    addMember(input: CreateMemberInput): { member: MemberRow; created: boolean } {
      const rows = d
        .insert(schema.member)
        .values({
          memberId: input.memberId,
          conversationId: input.conversationId,
          kind: input.kind,
          agentId: input.agentId ?? null,
          userRef: input.userRef ?? null,
          displayName: input.displayName ?? null,
          joinedAt: input.joinedAt,
        })
        .onConflictDoNothing()
        .returning()
        .all();
      const created = rows.length > 0;
      const member: MemberRow = created
        ? (schema.memberSelectSchema.parse(rows[0]) as MemberRow)
        : ({
            memberId: input.memberId,
            conversationId: input.conversationId,
            kind: input.kind,
            agentId: input.agentId ?? null,
            userRef: input.userRef ?? null,
            displayName: input.displayName ?? null,
            joinedAt: input.joinedAt,
          } as MemberRow);
      return { member, created };
    },

    getMembers(conversationId: string): MemberRow[] {
      return d
        .select()
        .from(schema.member)
        .where(eq(schema.member.conversationId, conversationId))
        .orderBy(schema.member.joinedAt)
        .all()
        .map((r) => schema.memberSelectSchema.parse(r) as MemberRow);
    },

    getAgentMembers(conversationId: string): MemberRow[] {
      return this.getMembers(conversationId).filter((m) => m.kind === "agent");
    },

    removeMember(conversationId: string, memberId: string): boolean {
      const rows = d
        .delete(schema.member)
        .where(
          and(
            eq(schema.member.conversationId, conversationId),
            eq(schema.member.memberId, memberId),
          ),
        )
        .returning()
        .all();
      return rows.length > 0;
    },
    // ─── Ledger ────────────────────────────────────

    appendLedgerEntry(input: AppendLedgerInput): number {
      const row = d
        .insert(schema.conversationLedger)
        .values({
          conversationId: input.conversationId,
          senderMemberId: input.senderMemberId,
          addressedTo: JSON.stringify(input.addressedTo ?? []),
          kind: input.kind,
          content: input.content,
          ts: input.ts,
        })
        .returning({ seq: schema.conversationLedger.seq })
        .get();
      return row!.seq;
    },

    getLedgerEntries(conversationId: string, opts?: { sinceSeq?: number }): LedgerEntry[] {
      const since = opts?.sinceSeq ?? 0;
      const rows = d
        .select()
        .from(schema.conversationLedger)
        .where(
          and(
            eq(schema.conversationLedger.conversationId, conversationId),
            gt(schema.conversationLedger.seq, since),
          ),
        )
        .orderBy(schema.conversationLedger.seq)
        .all();
      return rows.map((r) => {
        const result = schema.conversationLedgerSelectSchema.safeParse(r);
        if (result.success) return result.data as LedgerEntry;
        // Defensive fallback for rows with malformed JSON in addressedTo/content columns.
        return {
          seq: r.seq,
          conversationId: r.conversationId,
          senderMemberId: r.senderMemberId,
          addressedTo: [] as string[],
          kind: r.kind as LedgerEntry["kind"],
          content: r.content,
          ts: r.ts,
          undone: r.undone === 1,
        } as LedgerEntry;
      });
    },

    getLedgerEntry(conversationId: string, seq: number): LedgerEntry | null {
      const row = d
        .select()
        .from(schema.conversationLedger)
        .where(
          and(
            eq(schema.conversationLedger.conversationId, conversationId),
            eq(schema.conversationLedger.seq, seq),
          ),
        )
        .get();
      if (!row) return null;
      const result = schema.conversationLedgerSelectSchema.safeParse(row);
      if (result.success) return result.data as LedgerEntry;
      return {
        seq: row.seq,
        conversationId: row.conversationId,
        senderMemberId: row.senderMemberId,
        addressedTo: [] as string[],
        kind: row.kind as LedgerEntry["kind"],
        content: row.content,
        ts: row.ts,
        undone: row.undone === 1,
      } as LedgerEntry;
    },
    searchLedger(keyword: string, limit = 20) {
      const rows = d
        .select({
          conversationId: schema.conversationLedger.conversationId,
          seq: schema.conversationLedger.seq,
          content: schema.conversationLedger.content,
          ts: schema.conversationLedger.ts,
          senderName: schema.member.displayName,
          conversationTitle: schema.conversation.title,
        })
        .from(schema.conversationLedger)
        .leftJoin(
          schema.conversation,
          eq(schema.conversationLedger.conversationId, schema.conversation.conversationId),
        )
        .leftJoin(
          schema.member,
          and(
            eq(schema.conversationLedger.senderMemberId, schema.member.memberId),
            eq(schema.conversationLedger.conversationId, schema.member.conversationId),
          ),
        )
        .where(like(schema.conversationLedger.content, `%${keyword}%`))
        .limit(limit)
        .all();
      return rows.map((r) => ({
        conversationId: r.conversationId,
        seq: r.seq,
        snippet: r.content.slice(0, 200),
        ts: r.ts,
        senderName: r.senderName ?? "unknown",
        conversationTitle: r.conversationTitle ?? null,
      }));
    },
    markLedgerEntryUndone(conversationId: string, seq: number): void {
      d.update(schema.conversationLedger)
        .set({ undone: 1 })
        .where(
          and(
            eq(schema.conversationLedger.conversationId, conversationId),
            eq(schema.conversationLedger.seq, seq),
          ),
        )
        .run();
    },
    getForkSource(conversationId: string): { source: string; fromSeq: number } | null {
      const row = d
        .select({
          forkSource: schema.conversation.forkSource,
          forkFromSeq: schema.conversation.forkFromSeq,
        })
        .from(schema.conversation)
        .where(eq(schema.conversation.conversationId, conversationId))
        .get();
      if (!row?.forkSource || row.forkFromSeq === null) return null;
      return { source: row.forkSource, fromSeq: row.forkFromSeq };
    },
  };
}
