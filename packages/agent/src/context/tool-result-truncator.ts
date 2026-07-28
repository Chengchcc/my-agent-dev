import type { ContextManager } from "./context-manager.js";

export interface ToolResultTruncatorOptions {
  maxCharsPerResult: number;
}

export function toolResultTruncator(opts: ToolResultTruncatorOptions): ContextManager {
  const maxChars = opts.maxCharsPerResult;

  return {
    async shape(_ctx, messages) {
      return messages.map((msg) => {
        if (msg.role !== "user") return msg;
        const blocks = msg.blocks;
        if (!blocks) return msg;

        const truncated = blocks.map((block) => {
          if (block.type !== "tool_result") return block;
          if (block.content.length <= maxChars) return block;
          return {
            ...block,
            content:
              block.content.slice(0, maxChars) +
              `\n...[truncated, ${block.content.length - maxChars} chars]`,
          };
        });

        return { ...msg, blocks: truncated };
      });
    },
  };
}
