import type { SessionStore } from "../persistence/session-store.js";
import type { CodingSessionEntry } from "../persistence/session-tree.js";

export interface CompactionResult {
  readonly entryId: string;
  readonly coveredIds: readonly string[];
}

/** If the cut lands between an assistant tool_use and its tool_result,
 *  move the cut before the assistant so the pair stays intact. */
function adjustCutForToolPairs(messages: readonly CodingSessionEntry[], cutIdx: number): number {
  let cut = cutIdx;
  // While the first uncovered message is a tool_result whose assistant
  // tool_use is inside the covered region, pull the cut before that assistant.
  while (cut < messages.length && messages[cut]?.type === "message") {
    const first = messages[cut] as {
      role?: string;
      message?: { blocks?: Array<{ type?: string; tool_use_id?: string }> };
    };
    if (first.role !== "tool") break;
    const toolUseId = first.message?.blocks?.find((b) => b.type === "tool_result")?.tool_use_id;
    if (!toolUseId) break;
    // Find the assistant tool_use that produced this result, inside the covered region.
    let assocIdx = -1;
    for (let i = 0; i < cut; i++) {
      const m = messages[i] as {
        role?: string;
        message?: { blocks?: Array<{ type?: string; id?: string }> };
      };
      if (
        m.role === "assistant" &&
        m.message?.blocks?.some((b) => b.type === "tool_use" && b.id === toolUseId)
      ) {
        assocIdx = i;
      }
    }
    if (assocIdx === -1) break; // orphan result; nothing to pair
    // Cover up to (not including) the assistant: the whole pair stays.
    cut = assocIdx;
    break;
  }
  return cut;
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

  // Cut at oldest 60% of messages, adjusted to keep tool pairs intact.
  const rawCut = Math.floor(messages.length * 0.6);
  const cutIdx = adjustCutForToolPairs(messages, rawCut);
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
