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
