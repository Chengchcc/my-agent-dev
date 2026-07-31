import { describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { runSessionStoreContract } from "./session-store.contract.js";
import type { CodingSessionMetadata } from "./session-tree.js";
import { createSqliteSessionStore } from "./sqlite-session-store.js";

const dbPath = `/tmp/test-session-store-${Math.random().toString(36).slice(2, 10)}.db`;

runSessionStoreContract(
  "SQLite",
  async () => createSqliteSessionStore(dbPath),
  async () => {
    try {
      unlinkSync(dbPath);
    } catch {
      /* cleanup */
    }
  },
);

function meta(sessionId: string): CodingSessionMetadata {
  return {
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
}

describe("SQLite SessionStore specifics", () => {
  test("store rejects a second session id after binding", async () => {
    const store = createSqliteSessionStore(
      `/tmp/sqlite-guard-${Math.random().toString(36).slice(2, 8)}.db`,
    );
    await store.create(meta("one"));
    await expect(store.create(meta("two"))).rejects.toThrow(/bound to one/);
    await expect(store.appendBatch("two", { entries: [] })).rejects.toThrow(/bound to one/);
    await store.delete("one");
  });

  test("leaf cache is repaired from operation log when meta cache is stale", async () => {
    const path = `/tmp/sqlite-repair-${Math.random().toString(36).slice(2, 8)}.db`;
    const store = createSqliteSessionStore(path);
    await store.create(meta("repair"));
    await store.appendBatch("repair", {
      entries: [
        {
          type: "message",
          role: "user",
          source: "prompt",
          message: { role: "user", text: "one" },
          createdAt: Date.now(),
        },
        {
          type: "message",
          role: "assistant",
          source: "assistant",
          message: { role: "assistant", text: "two" },
          createdAt: Date.now(),
        },
      ],
    });

    // Corrupt the cached leaf directly (simulates a torn cache write).
    const { Database } = await import("bun:sqlite");
    const raw = new Database(path);
    raw.query("UPDATE meta SET leaf_entry_id = NULL").run();
    raw.close();

    // Reopen: open() must repair the leaf from the leaf_moved operation log.
    const reopened = createSqliteSessionStore(path);
    const snap = await reopened.open("repair");
    expect(snap.metadata.leafEntryId).toBeTruthy();
    expect(snap.entries).toHaveLength(2);
    // Leaf walks to the last appended entry (assistant "two").
    const branch = await reopened.readBranch("repair");
    expect(branch.at(-1)?.type).toBe("message");
    expect((branch.at(-1) as { source: string }).source).toBe("assistant");
    await reopened.delete("repair");
    try {
      unlinkSync(path);
    } catch {
      /* cleanup */
    }
  });
});
