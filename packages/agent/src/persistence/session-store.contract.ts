import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SessionStore } from "./session-store.js";
import type { CodingSessionMetadata } from "./session-tree.js";

/** Reusable contract suite for SessionStore implementations.
 *  Each adapter test imports and invokes this. */
export function runSessionStoreContract(
  name: string,
  factory: () => Promise<SessionStore>,
  cleanup?: () => Promise<void>,
): void {
  let store: SessionStore;
  const sessionId = `sess-${Math.random().toString(36).slice(2, 10)}`;
  const meta: CodingSessionMetadata = {
    sessionId,
    backendKind: "coding_agent",
    workspaceRoot: "/ws",
    modelRef: { backendKind: "anthropic", modelId: "claude-sonnet" },
    systemPromptHash: null,
    activeLoopId: null,
    leafEntryId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  beforeAll(async () => {
    store = await factory();
    await store.create(meta);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  function messageEntry(text: string, productEntryId?: string) {
    return {
      type: "message" as const,
      productEntryId,
      role: "user",
      source: "prompt" as const,
      message: { role: "user", text },
      createdAt: Date.now(),
    };
  }

  describe(`${name} SessionStore`, () => {
    test("create and open returns correct metadata", async () => {
      const snap = await store.open(sessionId);
      expect(snap.metadata.sessionId).toBe(sessionId);
      expect(snap.metadata.leafEntryId).toBeNull();
      expect(snap.entries).toHaveLength(0);
    });

    test("appendBatch appends entries atomically", async () => {
      const result = await store.appendBatch(sessionId, {
        entries: [messageEntry("hello", "pe1")],
      });
      expect(result.appendedIds).toHaveLength(1);

      const snap = await store.open(sessionId);
      expect(snap.metadata.leafEntryId!).toBe(result.appendedIds[0]!);
      expect(snap.entries).toHaveLength(1);
    });

    test("appendBatch skips duplicate productEntryIds", async () => {
      await store.appendBatch(sessionId, {
        entries: [messageEntry("hello", "pe1")],
      });
      const snap = await store.open(sessionId);
      expect(snap.entries).toHaveLength(1); // still 1, duplicate skipped
    });

    test("readBranch returns root-to-leaf order", async () => {
      await store.appendBatch(sessionId, {
        entries: [messageEntry("reply", "pe2")],
      });
      const branch = await store.readBranch(sessionId);
      expect(branch.length).toBeGreaterThanOrEqual(2);
    });

    test("moveLeaf navigates to existing entry", async () => {
      const entries = await store.readBranch(sessionId);
      const firstEntryId = entries[0]?.entryId;
      if (firstEntryId) {
        await store.moveLeaf(sessionId, firstEntryId);
        const snapAfter = await store.open(sessionId);
        expect(snapAfter.metadata.leafEntryId).toBe(firstEntryId);
        // leaf movement is a durable operation
        expect(snapAfter.operations.at(-1)?.type).toBe("leaf_moved");
        expect(snapAfter.operations.at(-1)?.entryId).toBe(firstEntryId);
      }
    });

    test("findByProductEntryIds returns matching entries", async () => {
      const found = await store.findByProductEntryIds(sessionId, ["pe1", "nonexistent"]);
      expect(found).toHaveLength(1);
      expect(found[0]?.type).toBe("message");
    });

    test("failed batch rolls back and writes nothing", async () => {
      const before = await store.open(sessionId);
      const beforeCount = before.entries.length;

      await expect(
        store.appendBatch(sessionId, {
          entries: [messageEntry("valid"), { type: "bogus" as never, createdAt: Date.now() }],
        }),
      ).rejects.toThrow();

      const after = await store.open(sessionId);
      expect(after.entries).toHaveLength(beforeCount);
      expect(after.metadata.leafEntryId).toBe(before.metadata.leafEntryId);
    });

    test("concurrent appends do not create accidental siblings", async () => {
      // Capture the current leaf before appending.
      const before = await store.open(sessionId);
      const [a, b] = await Promise.all([
        store.appendBatch(sessionId, { entries: [messageEntry("a")] }),
        store.appendBatch(sessionId, { entries: [messageEntry("b")] }),
      ]);
      expect(a.appendedIds).toHaveLength(1);
      expect(b.appendedIds).toHaveLength(1);

      // Both entries must be on one linear chain: leaf walks back through both.
      const branch = await store.readBranch(sessionId);
      const branchIds = branch.map((e) => e.entryId);
      expect(branchIds).toContain(a.appendedIds[0]!);
      expect(branchIds).toContain(b.appendedIds[0]!);
      // No orphaned sibling: every entry is reachable from the leaf.
      expect(branchIds).toHaveLength(new Set(branchIds).size);
      // The two new entries are consecutive children (no shared parent).
      const idxA = branchIds.indexOf(a.appendedIds[0]!);
      const idxB = branchIds.indexOf(b.appendedIds[0]!);
      expect(Math.abs(idxA - idxB)).toBe(1);
      // New leaf is one of the two appended entries.
      expect([a.appendedIds[0], b.appendedIds[0]]).toContain(branch.at(-1)?.entryId);
      // The pre-existing leaf is the parent of the first new entry (both
      // appends derived from the same leaf; no accidental sibling).
      const firstNewIdx = Math.min(idxA, idxB);
      const parentOfFirstNew = branch.at(firstNewIdx - 1)?.entryId;
      expect(parentOfFirstNew ?? null).toBe(before.metadata.leafEntryId);
    });

    test("todo state persists and latest entry wins on read", async () => {
      await store.appendBatch(sessionId, {
        entries: [
          {
            type: "todo",
            state: { items: [{ id: "t1", text: "first", status: "pending" }] },
            createdAt: Date.now(),
          },
        ],
      });
      await store.appendBatch(sessionId, {
        entries: [
          {
            type: "todo",
            state: { items: [{ id: "t1", text: "first", status: "done" }] },
            createdAt: Date.now(),
          },
        ],
      });
      const branch = await store.readBranch(sessionId);
      const todoEntries = branch.filter((e) => e.type === "todo");
      expect(todoEntries).toHaveLength(2);
      // readTodo scans from the leaf; the latest state is the last todo entry
      const latest = todoEntries.at(-1) as unknown as {
        state: { items: Array<{ status: string }> };
      };
      expect(latest.state.items[0]?.status).toBe("done");
    });

    test("compaction entry does not delete original entries", async () => {
      await store.appendBatch(sessionId, {
        entries: [
          messageEntry("old-1", "pe3"),
          messageEntry("old-2", "pe4"),
          messageEntry("old-3", "pe5"),
          messageEntry("old-4", "pe6"),
        ],
      });
      const branchBefore = await store.readBranch(sessionId);
      const msgIds = branchBefore.filter((e) => e.type === "message").map((e) => e.entryId);

      await store.appendBatch(sessionId, {
        entries: [
          {
            type: "compaction",
            summary: "compacted",
            coversEntryIds: msgIds.slice(0, 2),
            createdAt: Date.now(),
          },
        ],
      });

      const branchAfter = await store.open(sessionId);
      // Originals retained
      for (const id of msgIds) {
        expect(branchAfter.entries.some((e) => e.entryId === id)).toBe(true);
      }
      const comp = branchAfter.entries.filter((e) => e.type === "compaction");
      expect(comp).toHaveLength(1);
      expect((comp[0] as { coversEntryIds: readonly string[] }).coversEntryIds).toEqual(
        msgIds.slice(0, 2),
      );
    });

    test("delete removes session", async () => {
      await store.delete(sessionId);
      expect(store.open(sessionId)).rejects.toThrow();
    });
  });
}
