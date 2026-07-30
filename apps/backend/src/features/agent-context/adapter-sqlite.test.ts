import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openDb } from "../../infra/sqlite/db.js";
import { sqliteConversationAdapter } from "../conversation/adapter-sqlite.js";
import { sqliteAgentContextAdapter } from "./adapter-sqlite.js";
import { ContextRevisionConflictError } from "./domain.js";
import type { AgentContextPort } from "./ports.js";

const db = openDb(":memory:");
const conv = sqliteConversationAdapter(db);
const ctx: AgentContextPort = sqliteAgentContextAdapter(db);

/** Create a fresh conversation + agent member and return their IDs. */
function freshFixture(prefix: string): {
  conversationId: string;
  agentMemberId: string;
} {
  const conversationId = `conv-${prefix}`;
  const agentMemberId = `mem-${prefix}`;
  conv.createConversation({
    conversationId,
    triggerMode: "mention",
    createdAt: Date.now(),
  });
  conv.addMember({
    memberId: agentMemberId,
    conversationId,
    kind: "agent",
    agentId: `ag-${prefix}`,
    displayName: `Agent-${prefix}`,
    joinedAt: Date.now(),
  });
  return { conversationId, agentMemberId };
}

beforeAll(() => {
  // Add a human member to the shared conv-1 for the non-agent rejection test
  conv.createConversation({
    conversationId: "conv-shared",
    triggerMode: "mention",
    createdAt: Date.now(),
  });
  conv.addMember({
    memberId: "mem-human",
    conversationId: "conv-shared",
    kind: "human",
    userRef: "user-1",
    displayName: "Alice",
    joinedAt: Date.now(),
  });
});

afterAll(() => db.close());

describe("Agent Context: tree and default branch", () => {
  test("getOrCreateTree creates tree for agent member", async () => {
    const { conversationId, agentMemberId } = freshFixture("tree");
    const tree = await ctx.getOrCreateTree(conversationId, agentMemberId);
    expect(tree.conversationId).toBe(conversationId);
    expect(tree.agentMemberId).toBe(agentMemberId);
    expect(tree.treeId).toBeTruthy();
  });

  test("getOrCreateTree is idempotent", async () => {
    const { conversationId, agentMemberId } = freshFixture("idem");
    const t1 = await ctx.getOrCreateTree(conversationId, agentMemberId);
    const t2 = await ctx.getOrCreateTree(conversationId, agentMemberId);
    expect(t1.treeId).toBe(t2.treeId);
  });

  test("getTree returns null for unknown member", async () => {
    const { conversationId } = freshFixture("null");
    const tree = await ctx.getTree(conversationId, "mem-unknown");
    expect(tree).toBeNull();
  });

  test("getOrCreateTree rejects non-agent member", async () => {
    expect(ctx.getOrCreateTree("conv-shared", "mem-human")).rejects.toThrow();
  });

  test("getOrCreateDefaultBranch creates default branch", async () => {
    const { conversationId, agentMemberId } = freshFixture("branch");
    const tree = await ctx.getOrCreateTree(conversationId, agentMemberId);
    const branch = await ctx.getOrCreateDefaultBranch(tree.treeId, "coding_agent");
    expect(branch.treeId).toBe(tree.treeId);
    expect(branch.isDefault).toBe(true);
    expect(branch.backendKind).toBe("coding_agent");
    expect(branch.ledgerCursor).toBe(0);
    expect(branch.revision).toBe(1);
  });

  test("getOrCreateDefaultBranch is idempotent", async () => {
    const { conversationId, agentMemberId } = freshFixture("idem-branch");
    const tree = await ctx.getOrCreateTree(conversationId, agentMemberId);
    const b1 = await ctx.getOrCreateDefaultBranch(tree.treeId, "coding_agent");
    const b2 = await ctx.getOrCreateDefaultBranch(tree.treeId, "coding_agent");
    expect(b1.branchId).toBe(b2.branchId);
  });
});

describe("Agent Context: entry append and CAS", () => {
  test("appendEntry appends to leaf and increments revision", async () => {
    const { conversationId, agentMemberId } = freshFixture("append");
    const tree = await ctx.getOrCreateTree(conversationId, agentMemberId);
    const branch = await ctx.getOrCreateDefaultBranch(tree.treeId, "coding_agent");

    const result = await ctx.appendEntry({
      branchId: branch.branchId,
      expectedRevision: 1,
      type: "private_message",
      parentId: null,
      payload: { message: { role: "user", text: "private note" } },
    });
    expect(result.branch.revision).toBe(2);
    expect(result.branch.leafEntryId).toBe(result.entryId);

    const entries = await ctx.listEntriesToLeaf(branch.branchId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.type).toBe("private_message");
  });

  test("appendEntry CAS conflict throws", async () => {
    const { conversationId, agentMemberId } = freshFixture("cas");
    const tree = await ctx.getOrCreateTree(conversationId, agentMemberId);
    const branch = await ctx.getOrCreateDefaultBranch(tree.treeId, "coding_agent");

    await ctx.appendEntry({
      branchId: branch.branchId,
      expectedRevision: 1,
      type: "private_message",
      parentId: null,
      payload: { message: { role: "user", text: "first" } },
    });

    // Try to append with stale revision
    expect(
      ctx.appendEntry({
        branchId: branch.branchId,
        expectedRevision: 1,
        type: "private_message",
        parentId: null,
        payload: { message: { role: "user", text: "second" } },
      }),
    ).rejects.toThrow(ContextRevisionConflictError);
  });

  test("listEntriesToLeaf returns root-to-leaf order", async () => {
    const { conversationId, agentMemberId } = freshFixture("order");
    const tree = await ctx.getOrCreateTree(conversationId, agentMemberId);
    const branch = await ctx.getOrCreateDefaultBranch(tree.treeId, "coding_agent");

    const r1 = await ctx.appendEntry({
      branchId: branch.branchId,
      expectedRevision: 1,
      type: "ledger_message",
      parentId: null,
      payload: {},
      ledgerSeq: 1,
    });
    await ctx.appendEntry({
      branchId: branch.branchId,
      expectedRevision: 2,
      type: "ledger_message",
      parentId: r1.entryId,
      payload: {},
      ledgerSeq: 2,
    });

    const entries = await ctx.listEntriesToLeaf(branch.branchId);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.entryId).toBe(r1.entryId);
  });
});

describe("Agent Context: two-member isolation", () => {
  test("two agent members have isolated trees", async () => {
    const { conversationId } = freshFixture("iso1");
    conv.addMember({
      memberId: "mem-iso2",
      conversationId,
      kind: "agent",
      agentId: "ag-iso2",
      displayName: "Agent2",
      joinedAt: Date.now(),
    });

    const tree1 = await ctx.getOrCreateTree(conversationId, "mem-iso1");
    const tree2 = await ctx.getOrCreateTree(conversationId, "mem-iso2");
    expect(tree1.treeId).not.toBe(tree2.treeId);

    const branch1 = await ctx.getOrCreateDefaultBranch(tree1.treeId, "coding_agent");
    const branch2 = await ctx.getOrCreateDefaultBranch(tree2.treeId, "coding_agent");

    await ctx.appendEntry({
      branchId: branch1.branchId,
      expectedRevision: 1,
      type: "private_message",
      parentId: null,
      payload: { message: { role: "user", text: "agent1 private" } },
    });

    const entries2 = await ctx.listEntriesToLeaf(branch2.branchId);
    expect(entries2).toHaveLength(0);
  });
});

describe("Agent Context: ledger_message stores ref only", () => {
  test("ledger_message entry stores ledgerSeq, not message content", async () => {
    const { conversationId, agentMemberId } = freshFixture("ref");
    const seq = conv.appendLedgerEntry({
      conversationId,
      senderMemberId: agentMemberId,
      addressedTo: [],
      kind: "message",
      content: JSON.stringify({ text: "full message content" }),
      ts: Date.now(),
    });

    const tree = await ctx.getOrCreateTree(conversationId, agentMemberId);
    const branch = await ctx.getOrCreateDefaultBranch(tree.treeId, "coding_agent");
    const result = await ctx.appendEntry({
      branchId: branch.branchId,
      expectedRevision: 1,
      type: "ledger_message",
      parentId: null,
      payload: {},
      ledgerSeq: seq,
    });

    const entries = await ctx.listEntriesToLeaf(branch.branchId);
    const entry = entries[0];
    expect(entry?.type).toBe("ledger_message");
    if (entry?.type === "ledger_message") {
      expect(entry.ledgerSeq).toBe(seq);
    }
    // The entry payload must not contain the message content
    const raw = db
      .query("SELECT payload FROM agent_context_entry WHERE entry_id = ?")
      .get(result.entryId) as { payload: string };
    expect(raw.payload).not.toContain("full message content");
  });
});

describe("Agent Context: fork and move leaf", () => {
  test("fork creates new branch with inherited backend kind, preserves entries", async () => {
    const { conversationId, agentMemberId } = freshFixture("fork1");
    const tree = await ctx.getOrCreateTree(conversationId, agentMemberId);
    const branch = await ctx.getOrCreateDefaultBranch(tree.treeId, "coding_agent");
    const r1 = await ctx.appendEntry({
      branchId: branch.branchId,
      expectedRevision: 1,
      type: "private_message",
      parentId: null,
      payload: { message: { role: "user", text: "orig" } },
    });

    const { branch: forked } = await ctx.forkBranch({
      sourceBranchId: branch.branchId,
      expectedRevision: 2,
      fromEntryId: r1.entryId,
    });
    expect(forked.backendKind).toBe("coding_agent");
    expect(forked.isDefault).toBe(false);
    expect(forked.branchId).not.toBe(branch.branchId);

    // Original entries are not deleted
    const origEntries = await ctx.listEntriesToLeaf(branch.branchId);
    expect(origEntries).toHaveLength(1);

    // Forked branch sees the same entry
    const forkedEntries = await ctx.listEntriesToLeaf(forked.branchId);
    expect(forkedEntries).toHaveLength(1);
    expect(forkedEntries[0]?.entryId).toBe(r1.entryId);
  });

  test("fork can change backend kind", async () => {
    const { conversationId, agentMemberId } = freshFixture("fork2");
    const tree = await ctx.getOrCreateTree(conversationId, agentMemberId);
    const branch = await ctx.getOrCreateDefaultBranch(tree.treeId, "coding_agent");
    const r1 = await ctx.appendEntry({
      branchId: branch.branchId,
      expectedRevision: 1,
      type: "private_message",
      parentId: null,
      payload: { message: { role: "user", text: "orig" } },
    });

    const { branch: forked } = await ctx.forkBranch({
      sourceBranchId: branch.branchId,
      expectedRevision: 2,
      fromEntryId: r1.entryId,
      backendKind: "claude_code",
    });
    expect(forked.backendKind).toBe("claude_code");
  });

  test("move leaf does not delete entries", async () => {
    const { conversationId, agentMemberId } = freshFixture("move");
    const tree = await ctx.getOrCreateTree(conversationId, agentMemberId);
    const branch = await ctx.getOrCreateDefaultBranch(tree.treeId, "coding_agent");
    const r1 = await ctx.appendEntry({
      branchId: branch.branchId,
      expectedRevision: 1,
      type: "private_message",
      parentId: null,
      payload: { message: { role: "user", text: "first" } },
    });
    await ctx.appendEntry({
      branchId: branch.branchId,
      expectedRevision: 2,
      type: "private_message",
      parentId: r1.entryId,
      payload: { message: { role: "user", text: "second" } },
    });

    // Move leaf back to r1 (rollback)
    const moved = await ctx.moveBranchLeaf(branch.branchId, 3, r1.entryId);
    expect(moved.leafEntryId).toBe(r1.entryId);

    // Entries are not deleted
    const count = db
      .query("SELECT COUNT(*) as c FROM agent_context_entry WHERE tree_id = ?")
      .get(tree.treeId) as { c: number };
    expect(count.c).toBe(2);

    // listEntriesToLeaf now returns only up to r1
    const entries = await ctx.listEntriesToLeaf(branch.branchId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.entryId).toBe(r1.entryId);
  });
});

describe("Agent Context: binding", () => {
  test("upsertBinding creates and updates binding", async () => {
    const { conversationId, agentMemberId } = freshFixture("bind");
    const tree = await ctx.getOrCreateTree(conversationId, agentMemberId);
    const branch = await ctx.getOrCreateDefaultBranch(tree.treeId, "coding_agent");

    const binding = await ctx.upsertBinding({
      branchId: branch.branchId,
      backendSessionId: "sess-1",
      backendKind: "coding_agent",
      syncedEntryId: null,
      syncedRevision: null,
      state: "active",
      updatedAt: Date.now(),
    });
    expect(binding.backendSessionId).toBe("sess-1");

    const fetched = await ctx.getBinding(branch.branchId);
    expect(fetched?.backendSessionId).toBe("sess-1");

    // Update
    await ctx.upsertBinding({
      branchId: branch.branchId,
      backendSessionId: "sess-2",
      backendKind: "coding_agent",
      syncedEntryId: "entry-x",
      syncedRevision: 5,
      state: "active",
      updatedAt: Date.now(),
    });
    const updated = await ctx.getBinding(branch.branchId);
    expect(updated?.backendSessionId).toBe("sess-2");
    expect(updated?.syncedRevision).toBe(5);
  });

  test("markBindingStale sets state to stale", async () => {
    const { conversationId, agentMemberId } = freshFixture("stale");
    const tree = await ctx.getOrCreateTree(conversationId, agentMemberId);
    const branch = await ctx.getOrCreateDefaultBranch(tree.treeId, "coding_agent");
    await ctx.upsertBinding({
      branchId: branch.branchId,
      backendSessionId: "sess-stale",
      backendKind: "coding_agent",
      syncedEntryId: null,
      syncedRevision: null,
      state: "active",
      updatedAt: Date.now(),
    });

    await ctx.markBindingStale(branch.branchId);
    const binding = await ctx.getBinding(branch.branchId);
    expect(binding?.state).toBe("stale");
  });
});
