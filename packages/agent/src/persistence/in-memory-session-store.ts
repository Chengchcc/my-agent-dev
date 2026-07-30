import type { AppendBatchInput, AppendBatchResult, SessionStore } from "./session-store.js";
import type {
  CodingSessionEntry,
  CodingSessionMetadata,
  CodingSessionOperation,
  CodingSessionSnapshot,
} from "./session-tree.js";

export function createInMemorySessionStore(): SessionStore {
  const sessions = new Map<
    string,
    {
      metadata: CodingSessionMetadata;
      entries: CodingSessionEntry[];
      operations: CodingSessionOperation[];
      productEntrySet: Set<string>;
    }
  >();

  return {
    async create(metadata: CodingSessionMetadata): Promise<void> {
      if (sessions.has(metadata.sessionId)) {
        throw new Error(`Session ${metadata.sessionId} already exists`);
      }
      sessions.set(metadata.sessionId, {
        metadata: { ...metadata },
        entries: [],
        operations: [],
        productEntrySet: new Set(),
      });
    },

    async open(sessionId: string): Promise<CodingSessionSnapshot> {
      const s = sessions.get(sessionId);
      if (!s) throw new Error(`Session ${sessionId} not found`);
      return {
        metadata: { ...s.metadata },
        entries: [...s.entries],
        operations: [...s.operations],
      };
    },

    async delete(sessionId: string): Promise<void> {
      if (!sessions.delete(sessionId)) {
        throw new Error(`Session ${sessionId} not found`);
      }
    },

    async appendBatch(sessionId: string, input: AppendBatchInput): Promise<AppendBatchResult> {
      const s = sessions.get(sessionId);
      if (!s) throw new Error(`Session ${sessionId} not found`);

      const appendedIds: string[] = [];
      let parentId = s.metadata.leafEntryId;

      for (const entry of input.entries) {
        const productEntryId =
          "productEntryId" in entry
            ? (entry as { productEntryId?: string }).productEntryId
            : undefined;
        if (productEntryId && s.productEntrySet.has(productEntryId)) continue;

        const entryId = crypto.randomUUID().replace(/-/g, "").slice(0, 26);
        const now = Date.now();
        const full: CodingSessionEntry = {
          ...entry,
          entryId,
          parentId,
          createdAt: now,
        } as CodingSessionEntry;

        s.entries.push(full);
        if (productEntryId) s.productEntrySet.add(productEntryId);
        appendedIds.push(entryId);
        parentId = entryId;
      }

      if (appendedIds.length > 0) {
        (s.metadata as unknown as Record<string, unknown>).leafEntryId = parentId;
        (s.metadata as unknown as Record<string, unknown>).updatedAt = Date.now();
      }

      return { appendedIds };
    },

    async moveLeaf(sessionId: string, entryId: string): Promise<void> {
      const s = sessions.get(sessionId);
      if (!s) throw new Error(`Session ${sessionId} not found`);
      if (!s.entries.some((e) => e.entryId === entryId)) {
        throw new Error(`Entry ${entryId} not found`);
      }
      s.operations.push({ type: "leaf_moved", entryId, fromLeafId: s.metadata.leafEntryId });
      (s.metadata as unknown as Record<string, unknown>).leafEntryId = entryId;
      (s.metadata as unknown as Record<string, unknown>).updatedAt = Date.now();
    },

    async readBranch(sessionId: string): Promise<readonly CodingSessionEntry[]> {
      const s = sessions.get(sessionId);
      if (!s) throw new Error(`Session ${sessionId} not found`);
      // Walk from leaf to root via parent links, then reverse
      const result: CodingSessionEntry[] = [];
      let currentId = s.metadata.leafEntryId;
      const entryMap = new Map(s.entries.map((e) => [e.entryId, e]));
      while (currentId) {
        const entry = entryMap.get(currentId);
        if (!entry) break;
        result.push(entry);
        currentId = entry.parentId;
      }
      return result.reverse();
    },

    async findByProductEntryIds(
      sessionId: string,
      ids: readonly string[],
    ): Promise<readonly CodingSessionEntry[]> {
      const s = sessions.get(sessionId);
      if (!s) throw new Error(`Session ${sessionId} not found`);
      return s.entries.filter(
        (e) =>
          e.type === "message" &&
          (e as { productEntryId?: string }).productEntryId &&
          ids.includes((e as { productEntryId?: string }).productEntryId!),
      );
    },
  };
}
