import type { ProjectedHistoryItem } from "@my-agent-team/agent-backend";
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
  readonly conversationId: string;
  readonly branchId: string;
  readonly throughEntryId?: string;
}

/** Project a Context Branch's root-to-leaf entries into a linear
 *  `ProjectedHistoryItem[]` with stable `productEntryId`. Applies the latest
 *  applicable Summary by replacing entries through its
 *  `coversThroughEntryId`. Resolves Ledger Message refs through the narrow
 *  Conversation port query. */
export async function projectAgentContext(
  deps: ProjectionDeps,
  input: ProjectionInput,
): Promise<ProjectedHistoryItem[]> {
  const entries = await deps.port.listEntriesToLeaf(input.branchId);

  // If throughEntryId is specified, truncate to that entry
  let working: AgentContextEntry[] = entries;
  if (input.throughEntryId) {
    const idx = entries.findIndex((e) => e.entryId === input.throughEntryId);
    if (idx === -1) {
      throw new Error(`throughEntryId ${input.throughEntryId} is not on the selected branch path`);
    }
    working = entries.slice(0, idx + 1);
  }

  // Find the latest applicable Summary
  let summary: ProductSummaryEntry | null = null;
  for (let i = working.length - 1; i >= 0; i--) {
    if (working[i]?.type === "summary") {
      summary = working[i] as ProductSummaryEntry;
      break;
    }
  }

  // If a summary exists, replace entries through its coversThroughEntryId
  if (summary) {
    const coverIdx = working.findIndex((e) => e.entryId === summary.coversThroughEntryId);
    if (coverIdx === -1) {
      throw new Error(
        `Summary coverage target ${summary.coversThroughEntryId} not found on branch path`,
      );
    }
    const summaryIdx = working.findIndex((e) => e.entryId === summary.entryId);
    working = working.slice(Math.max(coverIdx + 1, summaryIdx));
  }

  // Build projected history items
  const items: ProjectedHistoryItem[] = [];
  for (const entry of working) {
    if (entry.type === "ledger_message") {
      const ledgerEntry = entry as LedgerMessageEntry;
      const message = await deps.ledgerResolver.resolveMessage(
        input.conversationId,
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
