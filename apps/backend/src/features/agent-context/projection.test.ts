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
    const entries = conv.getLedgerEntries(conversationId, { sinceSeq: ledgerSeq - 1 });
    const entry = entries.find((e) => e.seq === ledgerSeq);
    if (!entry) return null;
    return entry.content as never;
  },
};

afterAll(() => db.close());

function freshFixture(prefix: string) {
  const conversationId = `conv-proj-${prefix}`;
  const agentMemberId = `mem-proj-${prefix}`;
  conv.createConversation({ conversationId, triggerMode: "mention", createdAt: Date.now() });
  conv.addMember({
    memberId: agentMemberId,
    conversationId,
    kind: "agent",
    agentId: `ag-proj-${prefix}`,
    displayName: `ProjAgent-${prefix}`,
    joinedAt: Date.now(),
  });
  return { conversationId, agentMemberId };
}

describe("Agent Context projection", () => {
  test("linear order with stable productEntryId", async () => {
    const { conversationId, agentMemberId } = freshFixture("1");
    conv.appendLedgerEntry({
      conversationId,
      senderMemberId: agentMemberId,
      addressedTo: [],
      kind: "message",
      content: JSON.stringify({ role: "user", text: "msg-1" }),
      ts: Date.now(),
    });
    conv.appendLedgerEntry({
      conversationId,
      senderMemberId: agentMemberId,
      addressedTo: [],
      kind: "message",
      content: JSON.stringify({ role: "user", text: "msg-2" }),
      ts: Date.now(),
    });

    const tree = await port.getOrCreateTree(conversationId, agentMemberId);
    const branch = await port.getOrCreateDefaultBranch(tree.treeId, "coding_agent");
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
      { conversationId, branchId: branch.branchId },
    );
    expect(items).toHaveLength(2);
    expect(items[0]?.productEntryId).toBe(r1.entryId);
    expect(items[0]?.message.text).toBe("msg-1");
    expect(items[1]?.message.text).toBe("msg-2");
  });

  test("summary replaces covered entries without deleting them", async () => {
    const { conversationId, agentMemberId } = freshFixture("2");
    conv.appendLedgerEntry({
      conversationId,
      senderMemberId: agentMemberId,
      addressedTo: [],
      kind: "message",
      content: JSON.stringify({ role: "user", text: "old-msg" }),
      ts: Date.now(),
    });

    const tree = await port.getOrCreateTree(conversationId, agentMemberId);
    const branch = await port.getOrCreateDefaultBranch(tree.treeId, "coding_agent");
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
      { conversationId, branchId: branch.branchId },
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

  test("invalid throughEntryId throws", async () => {
    const { conversationId, agentMemberId } = freshFixture("3");
    const tree = await port.getOrCreateTree(conversationId, agentMemberId);
    const branch = await port.getOrCreateDefaultBranch(tree.treeId, "coding_agent");

    expect(
      projectAgentContext(
        { port, ledgerResolver },
        { conversationId, branchId: branch.branchId, throughEntryId: "nonexistent" },
      ),
    ).rejects.toThrow();
  });

  test("private messages are projected with stable productEntryId", async () => {
    const { conversationId, agentMemberId } = freshFixture("4");
    const tree = await port.getOrCreateTree(conversationId, agentMemberId);
    const branch = await port.getOrCreateDefaultBranch(tree.treeId, "coding_agent");
    const r1 = await port.appendEntry({
      branchId: branch.branchId,
      expectedRevision: 1,
      type: "private_message",
      parentId: null,
      payload: { message: { role: "user", text: "private" } },
    });

    const items = await projectAgentContext(
      { port, ledgerResolver },
      { conversationId, branchId: branch.branchId },
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.productEntryId).toBe(r1.entryId);
    expect(items[0]?.message.text).toBe("private");
  });
});
