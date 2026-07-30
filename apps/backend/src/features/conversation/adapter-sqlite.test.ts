import { afterAll, describe, expect, test } from "bun:test";
import { openDb } from "../../infra/sqlite/db.js";
import { sqliteConversationAdapter } from "./adapter-sqlite.js";

const db = openDb(":memory:");
const adapter = sqliteConversationAdapter(db);

afterAll(() => {
  db.close();
});

// ─── Conversation ──────────────────────────────────────────

describe("Conversation CRUD", () => {
  test("create inserts a conversation row", () => {
    const conv = adapter.createConversation({
      conversationId: "conv-1",
      triggerMode: "mention",
      createdAt: Date.now(),
    });
    expect(conv.conversationId).toBe("conv-1");
    expect(conv.triggerMode).toBe("mention");
    expect(conv.hopCount).toBe(0);
  });

  test("getById returns conversation or null", () => {
    const conv = adapter.getConversation("conv-1");
    expect(conv).not.toBeNull();
    expect(conv?.conversationId).toBe("conv-1");
  });

  test("getById returns null for nonexistent", () => {
    expect(adapter.getConversation("nope")).toBeNull();
  });

  test("updateHopCount increments hop_count", () => {
    adapter.updateHopCount("conv-1", 3);
    const conv = adapter.getConversation("conv-1");
    expect(conv?.hopCount).toBe(3);
  });

  test("updateHopCount resets to 0", () => {
    adapter.updateHopCount("conv-1", 0);
    const conv = adapter.getConversation("conv-1");
    expect(conv?.hopCount).toBe(0);
  });
});

// ─── Member ────────────────────────────────────────────────

describe("Member CRUD", () => {
  test("addMember inserts agent member", () => {
    const { member: mem } = adapter.addMember({
      memberId: "mem-x1",
      conversationId: "conv-1",
      kind: "agent",
      agentId: "ag-x",
      displayName: "XAgent",
      joinedAt: Date.now(),
    });
    expect(mem.memberId).toBe("mem-x1");
    expect(mem.kind).toBe("agent");
  });

  test("addMember inserts human member", () => {
    const { member: mem } = adapter.addMember({
      memberId: "mem-h1",
      conversationId: "conv-1",
      kind: "human",
      userRef: "user-1",
      displayName: "Alice",
      joinedAt: Date.now(),
    });
    expect(mem.memberId).toBe("mem-h1");
    expect(mem.kind).toBe("human");
  });

  test("getMembers returns all members for a conversation", () => {
    const members = adapter.getMembers("conv-1");
    expect(members).toHaveLength(2);
    expect(members.map((m) => m.memberId).sort()).toEqual(["mem-h1", "mem-x1"]);
  });

  test("removeMember deletes member", () => {
    const ok = adapter.removeMember("conv-1", "mem-h1");
    expect(ok).toBe(true);
    const members = adapter.getMembers("conv-1");
    expect(members).toHaveLength(1);
  });

  test("removeMember returns false for nonexistent", () => {
    expect(adapter.removeMember("conv-1", "nope")).toBe(false);
  });

  test("getAgentMember returns only agent members", () => {
    const agents = adapter.getAgentMembers("conv-1");
    expect(agents).toHaveLength(1);
    expect(agents[0]?.memberId).toBe("mem-x1");
  });
});

describe("Ledger CRUD", () => {
  test("appendLedgerEntry inserts and returns seq", () => {
    const seq = adapter.appendLedgerEntry({
      conversationId: "conv-1",
      senderMemberId: "mem-h1",
      addressedTo: ["mem-x1"],
      kind: "message",
      content: JSON.stringify({ text: "hello" }),
      ts: Date.now(),
    });
    expect(seq).toBe(1);
  });

  test("appendLedgerEntry auto-increments seq", () => {
    const seq = adapter.appendLedgerEntry({
      conversationId: "conv-1",
      senderMemberId: "mem-x1",
      addressedTo: [],
      kind: "message",
      content: JSON.stringify({ text: "response" }),
      ts: Date.now(),
    });
    expect(seq).toBe(2);
  });

  test("getLedgerEntries returns entries for a conversation", () => {
    const entries = adapter.getLedgerEntries("conv-1");
    expect(entries).toHaveLength(2);
    expect(entries[0]?.seq).toBe(1);
    expect(entries[0]?.kind).toBe("message");
    expect(entries[1]?.seq).toBe(2);
  });

  test("getLedgerEntries supports sinceSeq filter", () => {
    const entries = adapter.getLedgerEntries("conv-1", { sinceSeq: 1 });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.seq).toBe(2);
  });
});

describe("lastActivityAt", () => {
  test("listConversations reflects the latest ledger ts", () => {
    const before = adapter.listConversations().find((c) => c.conversationId === "conv-1");
    expect(before?.lastActivityAt).not.toBeNull();
    const later = (before?.lastActivityAt ?? 0) + 60_000;
    adapter.appendLedgerEntry({
      conversationId: "conv-1",
      senderMemberId: "mem-h1",
      addressedTo: [],
      kind: "message",
      content: JSON.stringify({ text: "newer" }),
      ts: later,
    });
    const after = adapter.listConversations().find((c) => c.conversationId === "conv-1");
    expect(after?.lastActivityAt).toBe(later);
  });

  test("getLastActivityAt returns null for conversation with no ledger", () => {
    adapter.createConversation({
      conversationId: "conv-empty",
      triggerMode: "mention",
      createdAt: Date.now(),
    });
    expect(adapter.getLastActivityAt?.("conv-empty")).toBeNull();
  });
});

describe("searchLedger", () => {
  test("finds entries matching keyword in content", () => {
    const results = adapter.searchLedger("hello");
    expect(results.length).toBeGreaterThan(0);
    const first = results[0]!;
    expect(first.conversationId).toBe("conv-1");
    expect(first.snippet).toContain("hello");
  });

  test("returns empty array for no match", () => {
    const results = adapter.searchLedger("nonexistent-keyword-xyz");
    expect(results).toEqual([]);
  });

  test("respects limit parameter", () => {
    const results = adapter.searchLedger("e", 1);
    expect(results.length).toBe(1);
  });
});

describe("no session binding surface", () => {
  test("member reads expose no session binding", () => {
    const members = adapter.getMembers("conv-1");
    for (const m of members) {
      expect("sessionId" in m).toBe(false);
      expect("session_id" in m).toBe(false);
    }
  });

  test("getMemberSessionId and updateMemberSessionId are not on the adapter", () => {
    expect("getMemberSessionId" in adapter).toBe(false);
    expect("updateMemberSessionId" in adapter).toBe(false);
  });
});
