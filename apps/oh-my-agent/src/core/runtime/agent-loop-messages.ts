import type { Message } from "@chengchenccc/message";
import type { ModelTurn } from "./agent-loop-types.js";
import { TOOL_FAILURE_REMINDER } from "./agent-loop-utils.js";

type ThinkingBlock = {
  type: "thinking";
  text: string;
  signature?: string;
  redacted?: boolean;
};

/** Single assembly point for a thinking block: applies the signature and
 *  redaction rules to any thinking text. */
function makeThinkingBlock(text: string, turn: ModelTurn): ThinkingBlock {
  return {
    type: "thinking",
    text: turn.thinkingRedacted ? "[reasoning redacted]" : text,
    ...(turn.thinkingSignature ? { signature: turn.thinkingSignature } : {}),
    ...(turn.thinkingRedacted ? { redacted: true } : {}),
  };
}

/** One thinking block from a turn's raw thinking (single assembly point:
 *  both the text turn and the tool turn persist through here). An empty
 *  thinking text with a signature (display: "omitted") still persists
 *  the signature must be replayed unchanged in tool-use turns. */
export function buildThinkingBlock(
  turn: ModelTurn,
): Array<{ type: "thinking"; text: string; signature?: string; redacted?: boolean }> {
  if (!turn.thinking && !turn.thinkingSignature) return [];
  // Collapse the interleaved thinking strands into one thinking block for
  // replay: Anthropic requires a single <thinking> per assistant message,
  // and signature/redacted attach at the end.
  return [makeThinkingBlock(turn.thinking, turn)];
}

export type ToolExecutionResult = {
  id: string;
  result: unknown;
  isError: boolean;
  terminate: boolean;
};

type BatchEntry = {
  type: "message";
  role: "assistant" | "tool";
  source: string;
  message: Message;
  createdAt: number;
};

/** Build the atomic assistant(tool_use) + tool_result batch for one turn. */
export function buildToolBatch(
  turn: ModelTurn,
  toolResults: readonly ToolExecutionResult[],
  opts: { toolFailureReminder?: boolean },
): BatchEntry[] {
  const collapsedThinking = makeThinkingBlock(turn.thinking, turn);
  const orderedWithCollapsedThinking: Array<{ type: string; text: string }> = [];
  let thinkingInserted = false;
  for (const b of turn.ordered) {
    if (b.type === "thinking") {
      if (!thinkingInserted) {
        orderedWithCollapsedThinking.push(collapsedThinking);
        thinkingInserted = true;
      }
      continue;
    }
    orderedWithCollapsedThinking.push(b);
  }
  if (!thinkingInserted && turn.thinking) {
    orderedWithCollapsedThinking.push(collapsedThinking);
  }

  const assistantMessage: Message = {
    role: "assistant",
    // Keep any narrative text the model emitted alongside tool calls
    // (DeepSeek interleaves thinking/text with tool_use). Text fragments
    // preserve their order; thinking fragments COLLAPSE into the single
    // thinking block inserted at the position of the first thinking
    // fragment.
    text: turn.text,
    blocks: [
      ...orderedWithCollapsedThinking,
      ...turn.toolCalls.map((tc) => ({
        type: "tool_use" as const,
        id: tc.id,
        name: tc.name,
        input: tc.input,
      })),
    ],
  } as Message;

  return [
    {
      type: "message",
      role: "assistant",
      source: "assistant",
      message: assistantMessage,
      createdAt: Date.now(),
    },
    ...toolResults.map((result) => {
      // Vision passthrough: a tool result carrying `images` (read_image)
      // keeps them on the tool_result block so providers map them onto the
      // wire content array.
      const imgs = (result.result as { images?: unknown } | null | undefined)?.images;
      const images =
        Array.isArray(imgs) && imgs.length > 0
          ? {
              images: imgs as Message["blocks"],
            }
          : {};
      // Tool result content contract (spec): a string `content` field is the
      // model-visible text verbatim (tool-formatted); everything else stays
      // the JSON dump for both model and UI.
      const res = result.result as { content?: unknown } | null | undefined;
      const raw = typeof res?.content === "string" ? res.content : JSON.stringify(result.result);
      // Tool-failure system reminder (absorbed from oh-my-pi): in-band on the
      // failing result so it survives into the canonical ledger — "the fix
      // sticks" across runs. The message `text` stays the clean JSON for UI.
      const content =
        result.isError && opts.toolFailureReminder !== false
          ? `${TOOL_FAILURE_REMINDER}\n\n${raw}`
          : raw;
      return {
        type: "message" as const,
        role: "tool" as const,
        source: "tool_result" as const,
        message: {
          role: "tool",
          text: raw,
          blocks: [
            {
              type: "tool_result" as const,
              tool_use_id: result.id,
              content,
              ...(result.isError ? { is_error: true } : {}),
              ...images,
            },
          ],
        } as Message,
        createdAt: Date.now(),
      };
    }),
  ];
}

/** Build the assistant(text) entry for a text-only turn. */
export function buildTextAssistantEntry(
  turn: ModelTurn,
  thinkingBlocks: ReturnType<typeof buildThinkingBlock>,
): BatchEntry {
  const blocks =
    turn.ordered.length > 0
      ? turn.ordered.map((b) => (b.type === "thinking" ? makeThinkingBlock(b.text, turn) : b))
      : thinkingBlocks.length > 0
        ? thinkingBlocks
        : undefined;

  return {
    type: "message",
    role: "assistant",
    source: "assistant",
    message: {
      role: "assistant",
      text: turn.text,
      // Preserve the interleaved thinking/text order from the stream. The
      // single collapsed thinking block (with signature) is still emitted for
      // replay compatibility when the stream had a signature, but the ordered
      // list keeps the trace faithful.
      blocks,
    },
    createdAt: Date.now(),
  };
}
