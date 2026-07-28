/** Shake: mechanically reduce context by replacing large tool results with placeholders.
 *  No LLM call -- pure string manipulation, faster and cheaper than summarization. */

import type { Message } from "@my-agent-team/message";

export interface ShakeConfig {
  /** Keep the most recent N tokens intact. Default: 16000. */
  protectTokens: number;
  /** Only shake if savings >= this threshold. Default: 4000. */
  minSavings: number;
  /** Tool names whose results are never shaken. Default: ["skill"]. */
  protectedTools: string[];
  /** Min token size for a tool result to be eligible. Default: 200. */
  minToolResultTokens: number;
}

export const DEFAULT_SHAKE_CONFIG: ShakeConfig = {
  protectTokens: 16_000,
  minSavings: 4_000,
  protectedTools: ["skill"],
  minToolResultTokens: 200,
};

const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Shake messages: replace large tool_result content with placeholders.
 *  Returns new messages array with reduced context. */
export function shakeMessages(
  messages: readonly Message[],
  config: ShakeConfig = DEFAULT_SHAKE_CONFIG,
): Message[] {
  // Build a set of tool_use names for protection lookup
  const toolNamesByUseId = new Map<string, string>();
  for (const msg of messages) {
    if (msg.blocks) {
      for (const b of msg.blocks) {
        if (b.type === "tool_use") {
          toolNamesByUseId.set(b.id, b.name);
        }
      }
    }
  }

  // Calculate total tokens
  let totalTokens = 0;
  for (const msg of messages) {
    totalTokens += estimateTokens(JSON.stringify(msg));
  }

  if (totalTokens <= config.protectTokens + config.minSavings) {
    return [...messages];
  }

  // Walk from the end, protecting the most recent protectTokens worth of content
  let protectedTokens = 0;
  let shakeBoundary = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(JSON.stringify(messages[i]));
    if (protectedTokens + msgTokens > config.protectTokens) {
      shakeBoundary = i + 1;
      break;
    }
    protectedTokens += msgTokens;
    shakeBoundary = i;
  }

  // Shake tool results before the boundary
  let savings = 0;
  const result = messages.map((msg, idx) => {
    if (idx >= shakeBoundary) return msg;
    if (!msg.blocks) return msg;

    const shakenBlocks = msg.blocks.map((block) => {
      if (block.type !== "tool_result") return block;

      // Check if this tool is protected
      const toolName = toolNamesByUseId.get(block.tool_use_id);
      if (toolName && config.protectedTools.includes(toolName)) return block;

      const contentTokens = estimateTokens(block.content);
      if (contentTokens < config.minToolResultTokens) return block;

      savings += contentTokens;
      return {
        ...block,
        content: `[Shaken: ${contentTokens} tokens of tool output omitted]`,
      };
    });

    return { ...msg, blocks: shakenBlocks };
  });

  if (savings < config.minSavings) {
    return [...messages];
  }

  return result;
}
