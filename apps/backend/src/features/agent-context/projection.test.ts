import { afterAll, describe, expect, test } from "bun:test";
import { openDb } from "../../infra/sqlite/db.js";
import { sqliteConversationAdapter } from "../conversation/adapter-sqlite.js";
import { sqliteAgentContextAdapter } from "./adapter-sqlite.js";
import type { AgentContextPort, LedgerMessageResolver } from "./ports.js";
import { projectAgentContext } from "./projection.js";

const db = openDb(":memory:");
const conv = sqliteConversationAdapter(db);
const port: AgentContextPort = sqliteAgentContextAdapter(db);
const ledgerResolver: LedgerMessageResolver = {
  async resolveMessage(conversationId, ledgerSeq) {
    const entry = conv.getLedgerEntry(conversationId, ledgerSeq);
    if (!entry) return null;
    return entry.content as never;
  },
};

afterAll(() => db.close());

function freshFixture(prefix: string) {
  const conversationId = `conv-proj-${prefix}`;
  const agentId = `ag-proj-${prefix}`;
  conv.createConversation({
    conversationId,
    agentId,
    createdAt: Date.now(),
  });
  return { conversationId, agentId };
}

describe("Agent Context projection", () => {
  test("linear order with stable productEntryId", async () => {
    const { conversationId, agentId } = freshFixture("1");
    conv.appendLedgerEntry({
      conversationId,
      senderMemberId: agentId,
      kind: "message",
      content: JSON.stringify({ role: "user", text: "msg-1" }),
      ts: Date.now(),
    });
    conv.appendLedgerEntry({
      conversationId,
      senderMemberId: agentId,
      kind: "message",
      content: JSON.stringify({ role: "user", text: "msg-2" }),
      ts: Date.now(),
    });

    const tree = await port.getOrCreateTree(conversationId);
    const branch = await port.getOrCreateDefaultBranch(tree.treeId, "oma");
    const r1 = await port.appendEntry({
      branchId: branch.branchId,
      expectedRevision: 1,
      type: "ledger_message",
      parentId: null,
      payload: {},
      ledgerSeq: 1,
    });
    await port.appendEntry({
      branchId: branch.branchId,
      expectedRevision: 2,
      type: "ledger_message",
      parentId: r1.entryId,
      payload: {},
      ledgerSeq: 2,
    });

    const items = await projectAgentContext(
      { port, ledgerResolver },
      { branchId: branch.branchId },
    );
    expect(items).toHaveLength(2);
    expect(items[0]?.productEntryId).toBe(r1.entryId);
    expect(items[0]?.message.text).toBe("msg-1");
    expect(items[1]?.message.text).toBe("msg-2");
  });

  test("summary replaces covered entries without deleting them", async () => {
    const { conversationId, agentId } = freshFixture("2");
    conv.appendLedgerEntry({
      conversationId,
      senderMemberId: agentId,
      kind: "message",
      content: JSON.stringify({ role: "user", text: "old-msg" }),
      ts: Date.now(),
    });

    const tree = await port.getOrCreateTree(conversationId);
    const branch = await port.getOrCreateDefaultBranch(tree.treeId, "oma");
    const r1 = await port.appendEntry({
      branchId: branch.branchId,
      expectedRevision: 1,
      type: "ledger_message",
      parentId: null,
      payload: {},
      ledgerSeq: 1,
    });
    // Add a summary covering r1
    await port.appendEntry({
      branchId: branch.branchId,
      expectedRevision: 2,
      type: "summary",
      parentId: r1.entryId,
      payload: { summary: "summary text", coversThroughEntryId: r1.entryId },
    });

    const items = await projectAgentContext(
      { port, ledgerResolver },
      { branchId: branch.branchId },
    );
    // The summary replaces the covered entry and itself produces a context message
    expect(items).toHaveLength(1);
    expect(items[0]?.message.text).toBe("summary text");

    // But the entry is not deleted from storage
    const count = db
      .query("SELECT COUNT(*) as c FROM agent_context_entry WHERE tree_id = ?")
      .get(tree.treeId) as { c: number };
    expect(count.c).toBe(2);
  });

  test("private messages are projected with stable productEntryId", async () => {
    const { conversationId } = freshFixture("4");
    const tree = await port.getOrCreateTree(conversationId);
    const branch = await port.getOrCreateDefaultBranch(tree.treeId, "oma");
    const r1 = await port.appendEntry({
      branchId: branch.branchId,
      expectedRevision: 1,
      type: "private_message",
      parentId: null,
      payload: { message: { role: "user", text: "private" } },
    });

    const items = await projectAgentContext(
      { port, ledgerResolver },
      { branchId: branch.branchId },
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.productEntryId).toBe(r1.entryId);
    expect(items[0]?.message.text).toBe("private");
  });

  test("summary retains uncovered tail entries after coverage point", async () => {
    const { conversationId, agentId } = freshFixture("tail");
    const seqCovered = conv.appendLedgerEntry({
      conversationId,
      senderMemberId: agentId,
      kind: "message",
      content: JSON.stringify({ role: "user", text: "covered-msg" }),
      ts: Date.now(),
    });
    const seqRetained = conv.appendLedgerEntry({
      conversationId,
      senderMemberId: agentId,
      kind: "message",
      content: JSON.stringify({ role: "user", text: "retained-msg" }),
      ts: Date.now(),
    });

    const tree = await port.getOrCreateTree(conversationId);
    const branch = await port.getOrCreateDefaultBranch(tree.treeId, "oma");
    // e1 (covered) -> e2 (retained) -> s1 (summary coversThrough=e1)
    const e1 = await port.appendEntry({
      branchId: branch.branchId,
      expectedRevision: 1,
      type: "ledger_message",
      parentId: null,
      payload: {},
      ledgerSeq: seqCovered,
    });
    const e2 = await port.appendEntry({
      branchId: branch.branchId,
      expectedRevision: 2,
      type: "ledger_message",
      parentId: e1.entryId,
      payload: {},
      ledgerSeq: seqRetained,
    });
    await port.appendEntry({
      branchId: branch.branchId,
      expectedRevision: 3,
      type: "summary",
      parentId: e2.entryId,
      payload: { summary: "summary text", coversThroughEntryId: e1.entryId },
    });

    const items = await projectAgentContext(
      { port, ledgerResolver },
      { branchId: branch.branchId },
    );
    // Expected: summary message + retained e2 message
    expect(items).toHaveLength(2);
    expect(items[0]?.message.text).toBe("summary text");
    expect(items[1]?.productEntryId).toBe(e2.entryId);
    expect(items[1]?.message.text).toBe("retained-msg");
  });

  test("projection resolves messages from the branch's own conversation", async () => {
    // Conversation A and B both hold a ledger entry with the same seq.
    // The branch lives in A; projection must resolve A's message even though
    // B was created first (and would be found by a naive global lookup).
    const a = freshFixture("a");
    const b = freshFixture("b");
    // B gets a ledger entry first so a naive cross-conversation lookup
    // would find B's message; the projection must still resolve A's.
    conv.appendLedgerEntry({
      conversationId: b.conversationId,
      senderMemberId: b.agentId,
      kind: "message",
      content: JSON.stringify({ role: "user", text: "msg-from-B" }),
      ts: Date.now(),
    });
    const seqA = conv.appendLedgerEntry({
      conversationId: a.conversationId,
      senderMemberId: a.agentId,
      kind: "message",
      content: JSON.stringify({ role: "user", text: "msg-from-A" }),
      ts: Date.now(),
    });
    // Use the same numeric seq for both conversations via a custom resolver
    // that returns a distinguishable message per conversation.
    const customResolver: LedgerMessageResolver = {
      async resolveMessage(conversationId, ledgerSeq) {
        const entry = conv.getLedgerEntry(conversationId, ledgerSeq);
        if (!entry) return null;
        return entry.content as never;
      },
    };

    const tree = await port.getOrCreateTree(a.conversationId);
    const branch = await port.getOrCreateDefaultBranch(tree.treeId, "oma");
    await port.appendEntry({
      branchId: branch.branchId,
      expectedRevision: 1,
      type: "ledger_message",
      parentId: null,
      payload: {},
      ledgerSeq: seqA,
    });

    const items = await projectAgentContext(
      { port, ledgerResolver: customResolver },
      { branchId: branch.branchId },
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.message.text).toBe("msg-from-A");
  });
});
