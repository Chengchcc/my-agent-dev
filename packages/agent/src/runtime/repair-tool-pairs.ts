import type { ContentBlock } from "@my-agent-team/core";
import type { Message } from "@my-agent-team/message";

/**
 * 修复消息列表中的 tool_use / tool_result 配对：
 * - 删除无配对 tool_result 的 tool_use 块
 * - 删除无配对 tool_use 的孤儿 tool_result 块
 * - 清理空 content 的非 system 消息
 *
 * 在 context manager 返回前调用，防 Anthropic 400（tool_use without tool_result）。
 */
export function repairToolPairs(messages: Message[]): Message[] {
  // Pass 1: 收集所有 tool_use id 和 tool_result 引用的 tool_use_id
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const msg of messages) {
    const blocks = contentAsBlocks(msg);
    for (const block of blocks) {
      if (block.type === "tool_use") {
        toolUseIds.add(block.id);
      }
      if (block.type === "tool_result") {
        toolResultIds.add(block.tool_use_id);
      }
    }
  }

  // Pass 2: 过滤
  const result: Message[] = [];
  for (const msg of messages) {
    let blocks = contentAsBlocks(msg);

    // 删除无配对 tool_use 的 tool_result，和无配对 tool_result 的 tool_use
    blocks = blocks.filter((block) => {
      if (block.type === "tool_use" && !toolResultIds.has(block.id)) return false;
      if (block.type === "tool_result" && !toolUseIds.has(block.tool_use_id)) return false;
      return true;
    });

    // 跳过空 content 的非 system 消息
    const hasContent = blocks.some((b) =>
      b.type === "text" ? typeof b.text === "string" && b.text.trim().length > 0 : true,
    );
    if (!hasContent && msg.role !== "system") continue;

    // 还原格式：如果原始是 text 且过滤后仍只有单 text 块，还原为 text
    const wasText = msg.text !== undefined;
    if (wasText && blocks.length === 1 && blocks[0]?.type === "text") {
      const textBlock = blocks[0] as { type: "text"; text: string };
      result.push({ ...msg, text: textBlock.text, blocks: undefined });
    } else {
      result.push({
        ...msg,
        text: undefined,
        blocks: blocks.length > 0 ? (blocks as ContentBlock[]) : undefined,
      });
    }
  }

  return result;
}

function contentAsBlocks(msg: Message): ContentBlock[] {
  if (msg.text !== undefined) {
    return msg.text.trim().length > 0 ? [{ type: "text" as const, text: msg.text }] : [];
  }
  return msg.blocks ?? [];
}
