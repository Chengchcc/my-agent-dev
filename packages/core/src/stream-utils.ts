import type { AIMessageChunk } from "./chat-model.js";
import type { ContentBlock, ToolUseBlock } from "./message.js";

export async function collectStream(stream: AsyncIterable<AIMessageChunk>): Promise<{
  blocks: ContentBlock[];
  stopReason?: AIMessageChunk["stopReason"];
  usage?: AIMessageChunk["usage"];
}> {
  const blocks: ContentBlock[] = [];
  const partialJson = new Map<string, string>();
  let stopReason: AIMessageChunk["stopReason"];
  let usage: AIMessageChunk["usage"];

  for await (const chunk of stream) {
    mergeChunkIntoBlocks(blocks, partialJson, chunk);
    if (chunk.stopReason !== undefined) {
      stopReason = chunk.stopReason;
    }
    if (chunk.usage !== undefined) {
      usage = chunk.usage;
    }
    if (chunk.done) {
      break;
    }
  }

  finalizeToolUseInputs(blocks, partialJson);
  return { blocks, stopReason, usage };
}

export function mergeChunkIntoBlocks(
  blocks: ContentBlock[],
  partialJson: Map<string, string>,
  chunk: AIMessageChunk,
): void {
  if (!chunk.delta) {
    return;
  }

  if (chunk.delta.type === "text") {
    const last = blocks.at(-1);
    if (last?.type === "text") {
      last.text += chunk.delta.text;
    } else {
      blocks.push({ type: "text", text: chunk.delta.text });
    }
    return;
  }

  // Reasoning is ephemeral (UI-only streaming); never persisted as a content block.
  if (chunk.delta.type === "reasoning" || chunk.delta.type === "reasoning_signature") {
    return;
  }

  if (chunk.delta.type === "tool_use") {
    blocks.push({ type: "tool_use", id: chunk.delta.id, name: chunk.delta.name, input: "" });
    return;
  }

  partialJson.set(
    chunk.delta.id,
    `${partialJson.get(chunk.delta.id) ?? ""}${chunk.delta.partial_json}`,
  );
}

export function finalizeToolUseInputs(
  blocks: ContentBlock[],
  partialJson: Map<string, string>,
): void {
  for (const block of blocks) {
    if (block.type !== "tool_use") {
      continue;
    }

    const rawInput = partialJson.get(block.id) ?? "";
    block.input = parseToolInput(rawInput);
  }
}

function parseToolInput(rawInput: string): ToolUseBlock["input"] {
  try {
    return JSON.parse(rawInput);
  } catch {
    return rawInput;
  }
}
