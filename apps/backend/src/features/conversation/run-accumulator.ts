import type { MessageRevision } from "@my-agent-team/message";
import {
  assistantMessageId,
  deserializeLedgerContent,
  isSucceededMessageState,
  isTerminalMessageState,
  serializeMessageRevision,
} from "@my-agent-team/message";
import type { RuntimeOpsStore } from "../runtime-ops/store.js";
import type { ConversationPort } from "./ports.js";
import type { ConversationService } from "./service.js";

// ─── @mention helpers ─────────────────────────────────────────

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

// ─── Preloaded messages (forkRun hot path) ────────────────────

/** Build preloaded Message[] for a run from the conversation ledger.
 *  Eliminates the thread_projection round-trip: the ledger is the canonical
 *  source, and materializing to thread_projection eagerly was a vestige of
 *  M9's persistence-only recovery path. */

export interface RunAccumulator {
  senderMemberId: string;
  mentionedMemberIds: Set<string>;
  lastTodoUpdate: { todos: unknown } | null;
  /** M17: Latest assistant revision written to the ledger for this run.
   *  Updated by onRunMessage callback; read by onRunComplete for the final done/error revision.
   *  M17.4: This is an optimization — if the process restarts and the accumulator is gone,
   *  onRunComplete falls back to scanning the ledger.
   *  M17.5 P7: Updated directly in main.ts onRunMessage instead of via projectionChain. */
  latestAssistantRevision: MessageRevision | null;
}

const runAccumulators = new Map<string, RunAccumulator>();

/** Origins that should not participate in @mention cascade. */
const ISOLATED_ORIGINS: Record<string, true> = { cron: true };

export function getOrCreateAccumulator(spanId: string, senderMemberId: string): RunAccumulator {
  let acc = runAccumulators.get(spanId);
  if (!acc) {
    acc = {
      senderMemberId,
      mentionedMemberIds: new Set(),
      lastTodoUpdate: null,
      latestAssistantRevision: null,
    };
    runAccumulators.set(spanId, acc);
  }
  return acc;
}

export function clearAccumulator(spanId: string): void {
  runAccumulators.delete(spanId);
}

// ─── Terminal projection helpers ──────────────────────────────

/** Scan the ledger for the latest assistant MessageRevision produced by `spanId`.
 *  Used as a fallback when the in-memory RunAccumulator is gone (process restart).
 *  Returns null if no matching revision is found. */
function findLatestAssistantRevision(
  port: ConversationPort,
  conversationId: string,
  spanId: string,
): MessageRevision | null {
  const entries = port.getLedgerEntries(conversationId);
  let latest: { rev: MessageRevision; seq: number } | null = null;
  for (const entry of entries) {
    if (entry.kind !== "message" || entry.spanId !== spanId) continue;
    const parsed = deserializeLedgerContent(entry.content);
    if (!("messageId" in parsed)) continue;
    if (parsed.role === "assistant" && (!latest || entry.seq > latest.seq)) {
      latest = { rev: parsed, seq: entry.seq };
    }
  }
  return latest?.rev ?? null;
}

/** Check if a terminal revision (done/error) already exists in the ledger
 *  for the given (spanId, messageId). Avoids repeated terminal writes when
 *  onRunComplete is invoked multiple times (reaper re-invocation, restart). */
function ledgerHasTerminalForMessage(
  port: ConversationPort,
  conversationId: string,
  spanId: string,
  messageId: string,
): boolean {
  const entries = port.getLedgerEntries(conversationId);
  for (const entry of entries) {
    if (entry.kind !== "message" || entry.spanId !== spanId) continue;
    const parsed = deserializeLedgerContent(entry.content);
    if (!("messageId" in parsed)) continue;
    if (parsed.messageId === messageId && isTerminalMessageState(parsed.state)) {
      return true;
    }
  }
  return false;
}

// ─── Terminal projection (onRunComplete) ──────────────────────

/** Conversation Projection handler: on run complete, await the projection chain,
 *  write a final done/error revision to close the open message, then release the lock
 *  and trigger side effects. Registered as supervisor.onRunComplete listener.
 *
 *  M17.5 P3: Split into three consistency tiers:
 *  Phase 1 (CRITICAL): terminal revision write + broadcast. Failure propagates.
 *  Phase 2 (CRITICAL): lock release in finally — always executes regardless of Phase 1.
 *  Phase 3 (BEST-EFFORT): todo append + @mention triggers — fire-and-forget, each caught. */

/** Run-completion handler. Supervisor AWAITS this — failure propagates (critical sink).
 *  P1: run_finalized already sent before this, so await doesn't block control signal.
 *
 *  Phase 1 (CRITICAL): terminal revision write + broadcast. Throws on failure.
 *  Phase 2 (CRITICAL finally): lock release — always executes.
 *  Phase 3 (BEST-EFFORT): todo append + @mention triggers — fire-and-forget, each caught. */
export async function onRunComplete(
  spanId: string,
  status: string,
  convPort: ConversationPort,
  convSvc: ConversationService,
  opsStore: RuntimeOpsStore,
  kind?: string,
  errorMessage?: string,
): Promise<void> {
  if (kind === "reflect") return;

  const origin = opsStore.getSpanOrigin(spanId);
  if (!origin) return;
  const cid = origin.conversationId;
  if (!cid) return;
  const senderMemberId = origin.agentMemberId;

  // M21: cron runs isolated — skip projection and @mention cascade to avoid double-drive.
  if (origin.originKind in ISOLATED_ORIGINS) {
    clearAccumulator(spanId);
    return;
  }

  const acc = runAccumulators.get(spanId);

  // ── Phase 1: CRITICAL — terminal revision write + broadcast ──
  try {
    const baseRev =
      acc?.latestAssistantRevision ?? findLatestAssistantRevision(convPort, cid, spanId);
    const frameworkSentTerminal = baseRev != null && isTerminalMessageState(baseRev.state);
    const statusConflict =
      baseRev != null && isSucceededMessageState(baseRev.state) && status !== "succeeded";

    if (!frameworkSentTerminal || statusConflict) {
      const errMsg = errorMessage || status;
      const finalRev: MessageRevision = baseRev
        ? {
            ...baseRev,
            state: status === "succeeded" ? "done" : "error",
            error: status === "succeeded" ? undefined : { message: errMsg },
            updatedAt: Date.now(),
          }
        : {
            messageId: assistantMessageId(spanId, 0),
            role: "assistant",
            state: status === "succeeded" ? "done" : "error",
            text: status === "succeeded" ? "" : `Run failed: ${errMsg}`,
            spanId,
            conversationId: cid,
            visibility: "conversation",
            updatedAt: Date.now(),
            error: status === "succeeded" ? undefined : { message: errMsg },
          };

      const messageId = finalRev.messageId;
      if (!ledgerHasTerminalForMessage(convPort, cid, spanId, messageId)) {
        const serialized = serializeMessageRevision(finalRev);
        if (!convPort.hasLedgerContent?.(spanId, serialized)) {
          const ts = Date.now();
          const _seq = convPort.appendLedgerEntry({
            conversationId: cid,
            senderMemberId,
            addressedTo: [],
            kind: "message",
            content: serialized,
            ts,
            spanId,
          });
        }
      }
    }
  } catch (err) {
    console.error(
      `[conversation] terminal projection failed for ${spanId}:`,
      err instanceof Error ? err.message : String(err),
    );
    throw err; // critical failure propagated — supervisor catches and logs
  } finally {
    // Phase 2: lock release always executes.
    convSvc.completeRun(cid, spanId, senderMemberId);
  }

  // ── Phase 3: BEST-EFFORT — fire-and-forget, each catches independently ──
  if (acc) {
    clearAccumulator(spanId);
    if (acc.lastTodoUpdate) {
      try {
        await convSvc.appendTodo(cid, acc.senderMemberId, acc.lastTodoUpdate.todos);
      } catch (err) {
        console.error(
          `[conversation] appendTodo failed for ${spanId}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    if (acc.mentionedMemberIds.size > 0) {
      void convSvc
        .triggerMentionedAgents({
          conversationId: cid,
          senderMemberId: acc.senderMemberId,
          addressedTo: [...acc.mentionedMemberIds],
        })
        .catch((err) =>
          console.error(
            `[conversation] triggerMentionedAgents failed for ${spanId}:`,
            err instanceof Error ? err.message : String(err),
          ),
        );
    }
  }
}
