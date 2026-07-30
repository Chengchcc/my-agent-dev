import type { ProjectedHistoryItem, AgentRunSnapshot } from "@my-agent-team/agent-backend";
import type { AppendBatchInput } from "../persistence/session-store.js";

export interface LoopInputResult {
  readonly batch: AppendBatchInput;
  readonly systemPrompt: string;
  readonly metaMessageId: string;
  readonly promptMessageId: string;
}

export interface LoopInputDeps {
  readonly systemPrompt: string;
  readonly metaText: string;
  readonly promptText: string;
}

export function buildLoopInput(
  history: readonly ProjectedHistoryItem[],
  _snapshot: AgentRunSnapshot<string>,
  deps: LoopInputDeps,
  mode: "normal" | "steer" | "follow_up" = "normal",
): LoopInputResult {
  const items: AppendBatchInput["entries"][number][] = [];

  for (const item of history) {
    items.push({
      type: "message",
      productEntryId: item.productEntryId,
      role: item.message.role as "user" | "assistant" | "system",
      source: "product_history",
      message: item.message,
      createdAt: Date.now(),
    } as AppendBatchInput["entries"][number]);
  }

  const metaId = crypto.randomUUID().replace(/-/g, "").slice(0, 26);
  if (mode !== "steer") {
    items.push({
      type: "message",
      productEntryId: null,
      role: "user",
      source: "meta",
      message: { role: "user", text: deps.metaText },
      createdAt: Date.now(),
    } as AppendBatchInput["entries"][number]);
  }

  const promptId = crypto.randomUUID().replace(/-/g, "").slice(0, 26);
  items.push({
    type: "message",
    productEntryId: null,
    role: "user",
    source: mode === "steer" ? "steer" : mode === "follow_up" ? "follow_up" : "prompt",
    message: { role: "user", text: deps.promptText },
    createdAt: Date.now(),
  } as AppendBatchInput["entries"][number]);

  return {
    batch: { entries: items },
    systemPrompt: deps.systemPrompt,
    metaMessageId: metaId,
    promptMessageId: promptId,
  };
}
