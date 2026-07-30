import type { SessionStore } from "../persistence/session-store.js";

export interface CompactionResult {
  readonly entryId: string;
  readonly coveredIds: readonly string[];
}

/** Compact a session branch: summarize oldest entries, append CompactionEntry,
 *  leave tail entries intact. Shared by threshold/manual/overflow triggers. */
export async function compactSession(
  store: SessionStore,
  sessionId: string,
  summarizer: (messages: readonly string[]) => Promise<string>,
): Promise<CompactionResult> {
  const branch = await store.readBranch(sessionId);
  const messages = branch.filter((e) => e.type === "message");
  if (messages.length < 4) return { entryId: "", coveredIds: [] };

  // Cut at oldest 60% of messages
  const cutIdx = Math.floor(messages.length * 0.6);
  const covered = messages.slice(0, cutIdx).map((m) => m.entryId);
  const text = messages
    .slice(0, cutIdx)
    .map((m) => (m as { message?: { text?: string } }).message?.text ?? "");

  const summary = await summarizer(text);
  const result = await store.appendBatch(sessionId, {
    entries: [
      {
        type: "compaction",
        summary,
        coversEntryIds: covered,
        createdAt: Date.now(),
      },
    ],
  });

  return {
    entryId: result.appendedIds[0] ?? "",
    coveredIds: covered,
  };
}
