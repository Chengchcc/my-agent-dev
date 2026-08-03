import type { Message } from "@my-agent-team/message";
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
  while (cut < messages.length && messages[cut]?.type === "message") {
    const first = messages[cut] as {
      role?: string;
      message?: { blocks?: Array<{ type?: string; tool_use_id?: string }> };
    };
    if (first.role !== "tool") break;
    const toolUseId = first.message?.blocks?.find((b) => b.type === "tool_result")?.tool_use_id;
    if (!toolUseId) break;
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
    if (assocIdx === -1) break;
    cut = assocIdx;
    break;
  }
  return cut;
}

/** Compact a session branch: summarize oldest entries, append CompactionEntry,
 *  leave tail entries intact. Shared by threshold/manual/overflow triggers.
 *
 *  The summarizer receives full Message objects (including tool_use/tool_result
 *  blocks) so tool semantics survive compaction. The AbortSignal lets stop()
 *  cancel an in-flight summarizer; an aborted compaction writes nothing. */
export async function compactSession(
  store: SessionStore,
  sessionId: string,
  summarizer: (messages: readonly Message[], signal?: AbortSignal) => Promise<string>,
  signal?: AbortSignal,
  budget?: { estimate(message: Message): number; limit: number },
): Promise<CompactionResult> {
  const branch = await store.readBranch(sessionId);
  const messages = branch.filter((e) => e.type === "message");
  if (messages.length < 4) return { entryId: "", coveredIds: [] };

  // Token-aware cut: if a budget is provided, accumulate from oldest to
  // newest until removing enough tokens to fit under limit. Otherwise fall
  // back to message-count heuristic.
  let cutIdx: number;
  let tokensBefore = 0;
  if (budget) {
    const allTokens = messages.reduce(
      (sum, m) => sum + budget!.estimate((m as { message: Message }).message),
      0,
    );
    tokensBefore = allTokens;
    const limit = budget.limit;
    let accumulated = allTokens;
    for (let i = 0; i < messages.length; i++) {
      const msgTokens = budget.estimate((messages[i] as { message: Message }).message);
      if (accumulated - msgTokens < limit) break;
      accumulated -= msgTokens;
      cutIdx = i + 1;
    }
  } else {
    cutIdx = Math.floor(messages.length * 0.6);
  }

  cutIdx = adjustCutForToolPairs(messages, cutIdx);
  const coveredEntries = messages.slice(0, cutIdx);
  const coveredIds = coveredEntries.map((m) => m.entryId);
  const retainedIds = messages.slice(cutIdx).map((m) => m.entryId);
  const coveredMessages = coveredEntries.map((m) => (m as { message: Message }).message);

  const summary = await summarizer(coveredMessages, signal);

  if (signal?.aborted) return { entryId: "", coveredIds: [] };

  const result = await store.appendBatch(sessionId, {
    entries: [
      {
        type: "compaction",
        summary,
        coversEntryIds: coveredIds,
        ...(budget ? { tokensBefore, retainedEntryIds: retainedIds } : {}),
        createdAt: Date.now(),
      },
    ],
  });

  return {
    entryId: result.appendedIds[0] ?? "",
    coveredIds: coveredIds,
  };
}
