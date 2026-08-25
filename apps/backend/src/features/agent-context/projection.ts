import type { ProjectedHistoryItem } from "@chengchenccc/agent-contract";
import type {
  AgentContextEntry,
  LedgerMessageEntry,
  PrivateMessageEntry,
  ProductSummaryEntry,
} from "./domain.js";
import type { AgentContextPort, LedgerMessageResolver } from "./ports.js";

export interface ProjectionDeps {
  readonly port: AgentContextPort;
  readonly ledgerResolver: LedgerMessageResolver;
}

export interface ProjectionInput {
  readonly branchId: string;
}

/** Project a Context Branch's root-to-leaf entries into a linear
 *  `ProjectedHistoryItem[]` with stable `productEntryId`. Applies the latest
 *  applicable Summary by replacing entries through its
 *  `coversThroughEntryId`. Resolves Ledger Message refs through the narrow
 *  Conversation port query. Every Agent Run rebuilds from this FULL
 *  projection - there is no incremental resume branch. */
export async function projectAgentContext(
  deps: ProjectionDeps,
  input: ProjectionInput,
): Promise<ProjectedHistoryItem[]> {
  // Derive conversationId from branch scope, do not trust caller
  const branch = await deps.port.getBranch(input.branchId);
  if (!branch) throw new Error(`Branch not found: ${input.branchId}`);
  const tree = await deps.port.getTreeById(branch.treeId);
  if (!tree) throw new Error(`Tree not found for branch ${input.branchId}`);
  const conversationId = tree.conversationId;
  const entries = await deps.port.listEntriesToLeaf(input.branchId);
  let working: AgentContextEntry[] = entries;

  // Find the latest applicable Summary
  let summary: ProductSummaryEntry | null = null;
  for (let i = working.length - 1; i >= 0; i--) {
    if (working[i]?.type === "summary") {
      summary = working[i] as ProductSummaryEntry;
      break;
    }
  }

  // If a summary exists: replace covered entries with the summary message,
  // keeping the summary entry first, then the retained tail between the
  // coverage point and the summary, then entries after the summary.
  if (summary) {
    const coverIdx = working.findIndex((e) => e.entryId === summary.coversThroughEntryId);
    if (coverIdx === -1) {
      throw new Error(
        `Summary coverage target ${summary.coversThroughEntryId} not found on branch path`,
      );
    }
    const summaryIdx = working.findIndex((e) => e.entryId === summary.entryId);
    const retainedTail = working.slice(coverIdx + 1, summaryIdx);
    const afterSummary = working.slice(summaryIdx + 1);
    working = [...working.slice(summaryIdx, summaryIdx + 1), ...retainedTail, ...afterSummary];
  }

  // Build projected history items
  const items: ProjectedHistoryItem[] = [];
  for (const entry of working) {
    if (entry.type === "ledger_message") {
      const ledgerEntry = entry as LedgerMessageEntry;
      const message = await deps.ledgerResolver.resolveMessage(
        conversationId,
        ledgerEntry.ledgerSeq,
      );
      if (!message) {
        throw new Error(`Ledger ref not found: ledgerSeq=${ledgerEntry.ledgerSeq}`);
      }
      items.push({ productEntryId: entry.entryId, message });
    } else if (entry.type === "private_message") {
      const privateEntry = entry as PrivateMessageEntry;
      items.push({ productEntryId: entry.entryId, message: privateEntry.message });
    } else if (entry.type === "summary") {
      // Summary replaces covered entries in the projection but itself produces
      // a context message so the model receives the condensed information.
      const summaryEntry = entry as ProductSummaryEntry;
      items.push({
        productEntryId: entry.entryId,
        message: {
          role: "user",
          text: summaryEntry.summary,
          visibility: "internal" as const,
        },
      });
    } else if (entry.type === "product_tool_exchange") {
      // Semantic tool exchanges are kept in projection as tool-call/result
      // messages so the model can see the interaction.
      const toolEntry = entry as { toolName: string; callResult: Record<string, unknown> };
      items.push({
        productEntryId: entry.entryId,
        message: {
          role: "tool" as const,
          text: JSON.stringify({ toolName: toolEntry.toolName, result: toolEntry.callResult }),
          visibility: "internal" as const,
        },
      });
    }
    // model_change entries don't produce projected history items.
  }

  return items;
}
