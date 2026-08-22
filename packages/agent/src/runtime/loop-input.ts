import type {
  AgentRunSnapshot,
  BackendInputMessage,
  ProjectedHistoryItem,
  WorkspaceBinding,
} from "@chengchenccc/agent-backend";
import type { AppendBatchInput } from "../persistence/session-store.js";
export interface LoopInputResult {
  readonly batch: AppendBatchInput;
  readonly systemPrompt: string;
}
/** Cross-boundary input for one loop. Carries only domain facts - NO metaText
 *  and NO systemPrompt: the OmaSession renders the Meta Message
 *  internally from run/workspace/plugin/todo state (renderLoopMeta is the sole
 *  Meta owner), and reads the system prompt from `run.systemPrompt`. */
export interface CodingLoopInput {
  readonly history: readonly ProjectedHistoryItem[];
  readonly input: BackendInputMessage;
  readonly run: AgentRunSnapshot<"oma">;
  readonly workspace: WorkspaceBinding;
  /** Product-run identity, when this run is product-driven (RPC path).
   *  Standalone CLI runs omit it: the agent has no product identity. */
  readonly metadata?: {
    readonly conversationId: string;
    readonly agentMemberId: string;
    readonly branchId: string;
  };
}

export interface LoopInputDeps {
  readonly systemPrompt: string;
  readonly metaText: string;
  /** The actual driving input for this loop. Its `message` is persisted as the
   *  prompt/follow-up entry (never inferred from history); `inputId` is the
   *  durable idempotency source; `productEntryId`, when present, is written onto
   *  the appended entry so the same canonical Message is never persisted twice. */
  readonly input: BackendInputMessage;
  /** Projected Product history to sync idempotently (productEntryId). */
  readonly history?: readonly ProjectedHistoryItem[];
}

/** Build the append batch for a loop: projected history + one Meta + the
 *  driving input Message (source = prompt for normal, follow_up otherwise).
 *  The input Message is preserved verbatim (blocks, role, identity). */
export function buildLoopInput(
  deps: LoopInputDeps,
  mode: "normal" | "follow_up" = "normal",
): LoopInputResult {
  const items: AppendBatchInput["entries"][number][] = [];

  for (const item of deps.history ?? []) {
    items.push({
      type: "message",
      productEntryId: item.productEntryId,
      role: item.message.role as "user" | "assistant" | "system",
      source: "product_history",
      message: item.message,
      createdAt: Date.now(),
    } as AppendBatchInput["entries"][number]);
  }

  // Every new loop gets exactly one Meta user message.
  items.push({
    type: "message",
    productEntryId: null,
    role: "user",
    source: "meta",
    message: { role: "user", text: deps.metaText },
    createdAt: Date.now(),
  } as AppendBatchInput["entries"][number]);

  // The driving input: the full canonical Message, source-tagged by mode.
  items.push({
    type: "message",
    productEntryId: deps.input.productEntryId ?? null,
    role: deps.input.message.role as "user" | "assistant" | "system",
    source: mode === "follow_up" ? "follow_up" : "prompt",
    message: deps.input.message,
    createdAt: Date.now(),
  } as AppendBatchInput["entries"][number]);

  return {
    batch: { entries: items },
    systemPrompt: deps.systemPrompt,
  };
}
