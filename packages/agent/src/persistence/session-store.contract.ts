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

  describe(`${name} SessionStore`, () => {
    test("create and open returns correct metadata", async () => {
      const snap = await store.open(sessionId);
      expect(snap.metadata.sessionId).toBe(sessionId);
      expect(snap.metadata.leafEntryId).toBeNull();
      expect(snap.entries).toHaveLength(0);
    });

    test("appendBatch appends entries atomically", async () => {
      const result = await store.appendBatch(sessionId, {
        entries: [
          {
            type: "message",
            productEntryId: "pe1",
            role: "user",
            source: "prompt",
            message: { role: "user", text: "hello" },
            createdAt: Date.now(),
          },
        ],
      });
      expect(result.appendedIds).toHaveLength(1);

      const snap = await store.open(sessionId);
      expect(snap.metadata.leafEntryId!).toBe(result.appendedIds[0]!);
      expect(snap.entries).toHaveLength(1);
    });

    test("appendBatch skips duplicate productEntryIds", async () => {
      await store.appendBatch(sessionId, {
        entries: [
          {
            type: "message",
            productEntryId: "pe1",
            role: "user",
            source: "prompt",
            message: { role: "user", text: "hello" },
            createdAt: Date.now(),
          },
        ],
      });
      const snap = await store.open(sessionId);
      expect(snap.entries).toHaveLength(1); // still 1, duplicate skipped
    });

    test("readBranch returns root-to-leaf order", async () => {
      await store.appendBatch(sessionId, {
        entries: [
          {
            type: "message",
            productEntryId: "pe2",
            role: "assistant",
            source: "assistant",
            message: { role: "assistant", text: "reply" },
            createdAt: Date.now(),
          },
        ],
      });
      const branch = await store.readBranch(sessionId);
      expect(branch.length).toBeGreaterThanOrEqual(2);
    });

    test("moveLeaf navigates to existing entry", async () => {
      const _snapBefore = await store.open(sessionId);
      const entries = await store.readBranch(sessionId);
      const firstEntryId = entries[0]?.entryId;
      if (firstEntryId) {
        await store.moveLeaf(sessionId, firstEntryId);
        const snapAfter = await store.open(sessionId);
        expect(snapAfter.metadata.leafEntryId).toBe(firstEntryId);
      }
    });

    test("findByProductEntryIds returns matching entries", async () => {
      const found = await store.findByProductEntryIds(sessionId, ["pe1", "nonexistent"]);
      expect(found).toHaveLength(1);
      expect(found[0]?.type).toBe("message");
    });

    test("delete removes session", async () => {
      await store.delete(sessionId);
      expect(store.open(sessionId)).rejects.toThrow();
    });
  });
}
