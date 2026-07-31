import type {
  CodingSessionEntry,
  CodingSessionMetadata,
  CodingSessionSnapshot,
} from "./session-tree.js";

export interface AppendBatchInput {
  readonly entries: readonly Record<string, unknown>[];
}

export interface AppendBatchResult {
  readonly appendedIds: readonly string[];
}

/** Validate a batch before any write. Throws on the first invalid entry so
 *  both adapters fail atomically with identical semantics. */
export function validateBatch(entries: readonly Record<string, unknown>[]): void {
  for (const entry of entries) {
    const type = entry.type;
    if (type !== "message" && type !== "compaction" && type !== "todo") {
      throw new Error(`Invalid entry type: ${String(type)}`);
    }
    if (type === "message") {
      const msg = entry.message as { role?: unknown } | undefined;
      if (!msg || typeof msg !== "object" || typeof msg.role !== "string") {
        throw new Error("Message entry requires a message object with a role");
      }
    }
    if (type === "compaction" && typeof entry.summary !== "string") {
      throw new Error("Compaction entry requires a summary string");
    }
    if (type === "todo" && typeof entry.state !== "object") {
      throw new Error("Todo entry requires a state object");
    }
  }
}

export interface SessionStore {
  /** Create a new session. */
  create(metadata: CodingSessionMetadata): Promise<void>;

  /** Open an existing session, returning current snapshot. */
  open(sessionId: string): Promise<CodingSessionSnapshot>;

  /** Delete a session and all its data. */
  delete(sessionId: string): Promise<void>;

  /** Atomically append a batch of entries. ParentIds are derived from the
   *  current leaf. Duplicate productEntryIds in the batch are skipped.
   *  The leaf is updated only after the full batch succeeds. */
  appendBatch(sessionId: string, input: AppendBatchInput): Promise<AppendBatchResult>;

  /** Move the session leaf to an existing entry. Appends a leaf_moved operation. */
  moveLeaf(sessionId: string, entryId: string): Promise<void>;

  /** Read all entries on the current branch from root to leaf. */
  readBranch(sessionId: string): Promise<readonly CodingSessionEntry[]>;

  /** Find entries by their product entry IDs. */
  findByProductEntryIds(
    sessionId: string,
    ids: readonly string[],
  ): Promise<readonly CodingSessionEntry[]>;
}
