import type { Message } from "@my-agent-team/message";

/** Configuration for old tool-result pruning. */
export interface PruneConfig {
  /** Protect the most recent N tokens of tool results from pruning. Tools
   *  whose combined output falls within this window are left intact. */
  readonly protectTokens: number;
  /** Only prune if total savings meets this threshold (avoids churning small
   *  prunes that barely reduce context). */
  readonly minimumSavings: number;
  /** Tool names whose results are NEVER pruned (pi's tool-protection). Use
   *  for tools whose output must remain visible: skill reads, plan files,
   *  config snapshots. */
  readonly protectedTools: ReadonlySet<string>;
}

const DEFAULT_CONFIG: PruneConfig = {
  protectTokens: 8_000,
  minimumSavings: 500,
  protectedTools: new Set(),
};

const PRUNED_PREFIX = "[pruned:";

/** Check whether a message's tool_result blocks have already been pruned. */
function isAlreadyPruned(message: Message): boolean {
  if (message.role !== "tool" || !message.blocks) return false;
  return message.blocks.some(
    (b) =>
      b.type === "tool_result" &&
      typeof b.content === "string" &&
      b.content.startsWith(PRUNED_PREFIX),
  );
}

/** Estimate token count of a message (same proxy as contextBudget: char/4). */
function estimateTokens(message: Message): number {
  // Blocks are canonical content; text is a display fallback. When blocks
  // exist, count their content only — avoids double-counting text+blocks.
  if (message.blocks && message.blocks.length > 0) {
    let chars = 0;
    for (const b of message.blocks) {
      if (b.type === "tool_result" && typeof b.content === "string") chars += b.content.length;
      else if (b.type === "text") chars += b.text.length;
    }
    return Math.ceil(chars / 4);
  }
  return Math.ceil((message.text?.length ?? 0) / 4);
}

/** Prune old tool-result content from a message list (pi's pruneToolOutputs).
 *
 *  Walks backward from the newest message, accumulating tool-result tokens.
 *  Once the protect window is exceeded, tool results outside the window are
 *  truncated to a short summary — the pairing stays intact (the tool_use
 *  block is never touched) but the verbose output is replaced. Protected
 *  tools (skills, plans, config) are never pruned.
 *
 *  This is a READ-SIDE transform: the stored entries are unchanged. The model
 *  sees truncated results; the UI trace reads the full original from the store. */
export function pruneOldToolResults(
  messages: readonly Message[],
  config: Partial<PruneConfig> = {},
): { messages: Message[]; savedTokens: number } {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  let protectedTokens = 0;
  let savedTokens = 0;

  // Walk backward: accumulate recent tool output into the protect window.
  const pruned = [...messages];
  for (let i = pruned.length - 1; i >= 0; i--) {
    const msg = pruned[i]!;
    if (msg.role !== "tool" || !msg.blocks) continue;
    if (isAlreadyPruned(msg)) continue;

    // Check if this tool result comes from a protected tool — we need to
    // find the associated tool_use block to get the tool name. Walk forward
    // from this tool message's position is wrong — the tool_use is in a
    // PRIOR assistant message. We match by tool_use_id.
    const toolResultBlock = msg.blocks.find((b) => b.type === "tool_result");
    if (!toolResultBlock || toolResultBlock.type !== "tool_result") continue;

    // Find the associated tool_use to check if the tool is protected.
    let toolName: string | undefined;
    for (let j = i - 1; j >= 0; j--) {
      const prev = pruned[j]!;
      if (prev.role !== "assistant" || !prev.blocks) continue;
      const use = prev.blocks.find(
        (b) => b.type === "tool_use" && b.id === toolResultBlock.tool_use_id,
      );
      if (use && use.type === "tool_use") {
        toolName = use.name;
        break;
      }
    }

    // Protected tools are never pruned.
    if (toolName && cfg.protectedTools.has(toolName)) continue;

    const msgTokens = estimateTokens(msg);
    protectedTokens += msgTokens;

    // Within the protect window — leave intact.
    if (protectedTokens <= cfg.protectTokens) continue;

    // Outside the window — truncate the tool_result content.
    const originalTokens = msgTokens;
    const summary = truncateContent(
      typeof msg.text === "string" ? msg.text : "",
      toolResultBlock.content,
    );
    pruned[i] = {
      ...msg,
      text: summary,
      blocks: msg.blocks.map((b) =>
        b.type === "tool_result" && b.tool_use_id === toolResultBlock.tool_use_id
          ? { ...b, content: summary }
          : b,
      ),
    };
    const prunedTokens = estimateTokens(pruned[i]!);
    savedTokens += originalTokens - prunedTokens;
  }

  if (savedTokens < cfg.minimumSavings) {
    return { messages: [...messages], savedTokens: 0 };
  }
  return { messages: pruned, savedTokens };
}

/** Produce a short summary of pruned content: first 200 chars + line count. */
function truncateContent(text: string, content: string): string {
  const source = content || text;
  if (source.length <= 200) return source;
  const lines = source.split("\n").length;
  return `${PRUNED_PREFIX} ${lines} lines, ${source.length} chars] ${source.slice(0, 200)}…`;
}
