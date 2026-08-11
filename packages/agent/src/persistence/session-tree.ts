import type { Message } from "@my-agent-team/message";

// ─── Coding Session Tree entries ─────────────────────────────────

export interface MessageEntry {
  readonly type: "message";
  readonly entryId: string;
  readonly parentId: string | null;
  readonly role: "user" | "assistant" | "system" | "tool";
  readonly source:
    | "product_history"
    | "meta"
    | "prompt"
    | "steer"
    | "follow_up"
    | "assistant"
    | "tool_result";
  readonly message: Message;
  readonly createdAt: number;
}

export interface CompactionEntry {
  readonly type: "compaction";
  readonly entryId: string;
  readonly parentId: string | null;
  readonly summary: string;
  readonly coversEntryIds: readonly string[];
  /** Estimated token count of covered messages before compaction. */
  readonly tokensBefore?: number;
  /** Entry IDs deliberately left uncovered (the retained tail). */
  readonly retainedEntryIds?: readonly string[];
  readonly createdAt: number;
}

export interface TodoStateEntry {
  readonly type: "todo";
  readonly entryId: string;
  readonly parentId: string | null;
  readonly state: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
}
export interface ThinkingLevelChangeEntry {
  readonly type: "thinking_level_change";
  readonly entryId: string;
  readonly parentId: string | null;
  readonly thinkingLevel: string | null;
  readonly createdAt: number;
}

export interface ModelChangeEntry {
  readonly type: "model_change";
  readonly entryId: string;
  readonly parentId: string | null;
  /** Model in "provider/modelId" format. */
  readonly model: string;
  readonly createdAt: number;
}

export type CodingSessionEntry =
  | MessageEntry
  | CompactionEntry
  | TodoStateEntry
  | ThinkingLevelChangeEntry
  | ModelChangeEntry;

export type CodingSessionOperation = {
  readonly type: "leaf_moved";
  readonly entryId: string;
  readonly fromLeafId: string | null;
};

// ─── Coding Session metadata ─────────────────────────────────────

export interface CodingSessionMetadata {
  readonly sessionId: string;
  readonly backendKind: string;
  readonly workspaceRoot: string;
  readonly leafEntryId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CodingSessionSnapshot {
  readonly metadata: CodingSessionMetadata;
  readonly entries: readonly CodingSessionEntry[];
  readonly operations: readonly CodingSessionOperation[];
}
