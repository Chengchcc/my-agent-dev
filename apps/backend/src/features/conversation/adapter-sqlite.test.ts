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

  test("getLedgerEntry returns the exact record by (conversationId, seq)", () => {
    const entry = adapter.getLedgerEntry("conv-1", 1);
    expect(entry).not.toBeNull();
    expect(entry!.seq).toBe(1);
    expect(entry!.conversationId).toBe("conv-1");
    expect(entry!.kind).toBe("message");
    expect(entry!.content as unknown).toEqual({ text: "hello" }); // parsed, not raw string

    const second = adapter.getLedgerEntry("conv-1", 2);
    expect(second?.seq).toBe(2);
  });

  test("getLedgerEntry returns null for unknown seq or conversation", () => {
    expect(adapter.getLedgerEntry("conv-1", 999)).toBeNull();
    expect(adapter.getLedgerEntry("conv-unknown", 1)).toBeNull();
  });

  test("getLedgerEntry is exact per conversation", () => {
    adapter.createConversation({
      conversationId: "conv-2",
      triggerMode: "mention",
      createdAt: Date.now(),
    });
    const seq2 = adapter.appendLedgerEntry({
      conversationId: "conv-2",
      senderMemberId: "mem-y",
      addressedTo: [],
      kind: "message",
      content: JSON.stringify({ text: "other conv" }),
      ts: Date.now(),
    });
    // conv-2's row carries a NEW global seq; it must not resolve for conv-1.
    expect(adapter.getLedgerEntry("conv-1", seq2)).toBeNull();
    expect(adapter.getLedgerEntry("conv-2", seq2)?.content as unknown).toEqual({
      text: "other conv",
    });
    // conv-1's own rows still resolve to conv-1's records.
    expect(adapter.getLedgerEntry("conv-1", 1)?.content as unknown).toEqual({ text: "hello" });
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

// ─── deleteConversation ────────────────────────────────────

describe("deleteConversation", () => {
  function makeConversation(): string {
    const id = `del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    adapter.createConversation({
      conversationId: id,
      agentId: "ag-del",
      triggerMode: "mention",
      createdAt: Date.now(),
    });
    return id;
  }

  test("deletes a conversation with a multi-entry self-referencing context chain", async () => {
    const id = makeConversation();
    const now = Date.now();
    db.exec(
      `INSERT INTO agent_context_tree (tree_id, conversation_id, created_at)
       VALUES ('tree-${id}', '${id}', ${now})`,
    );
    // Linear chain: entry2.parent_id -> entry1, entry3.parent_id -> entry2.
    // The self-referencing FK (RESTRICT by default) breaks the naive cascade.
    db.exec(
      `INSERT INTO agent_context_entry (entry_id, tree_id, parent_id, type, payload, created_at)
       VALUES ('e1-${id}', 'tree-${id}', NULL, 'ledger_message', '{}', ${now}),
              ('e2-${id}', 'tree-${id}', 'e1-${id}', 'ledger_message', '{}', ${now}),
              ('e3-${id}', 'tree-${id}', 'e2-${id}', 'ledger_message', '{}', ${now})`,
    );

    expect(await adapter.deleteConversation(id)).toBe(true);
    expect(adapter.getConversation(id)).toBeNull();
    const left = (
      db
        .query("SELECT COUNT(*) AS c FROM agent_context_entry WHERE tree_id = ?")
        .get(`tree-${id}`) as {
        c: number;
      }
    ).c;
    expect(left).toBe(0);
  });

  test("rejects delete while an active run exists", async () => {
    const id = makeConversation();
    const now = Date.now();
    db.exec(
      `INSERT INTO agent_context_tree (tree_id, conversation_id, created_at)
       VALUES ('tree-run-${id}', '${id}', ${now})`,
    );
    db.exec(
      `INSERT INTO agent_context_branch (branch_id, tree_id, ledger_cursor, backend_kind, is_default, revision, created_at)
       VALUES ('br-${id}', 'tree-run-${id}', 0, 'anthropic', 1, 1, ${now})`,
    );
    db.exec(
      `INSERT INTO agent_run (run_id, branch_id, conversation_id, agent_id, model_ref, status, idempotency_key, config_revision, created_at)
       VALUES ('run-${id}', 'br-${id}', '${id}', 'ag-1', '{}', 'running', 'ik-${id}', 1, ${now})`,
    );

    await expect(adapter.deleteConversation(id)).rejects.toThrow(
      "Conversation has an active run; stop it before deleting.",
    );
    expect(adapter.getConversation(id)).not.toBeNull();

    // Terminal run does not block deletion.
    db.exec(`UPDATE agent_run SET status = 'completed' WHERE run_id = 'run-${id}'`);
    expect(await adapter.deleteConversation(id)).toBe(true);
    expect(adapter.getConversation(id)).toBeNull();
  });
});
