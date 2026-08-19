import type { Message } from "@chengchenccc/message";
import { ToolCallCard } from "@/components/ToolCallCard";
import { ToolResultCard } from "@/components/ToolResultCard";

export interface BlockLike {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  text?: string;
  base64?: string;
  mediaType?: string;
}

/** Normalize tool_result.content to string. Handles string, ContentBlock[], and null. */
export function normalizeToolResultContent(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter(
        (p): p is { type: string; text?: string } =>
          !!p && typeof p === "object" && (p as { type?: string }).type === "text",
      )
      .map((p) => p.text ?? "")
      .join("\n");
  }
  return c == null ? "" : JSON.stringify(c);
}

/** Collect tool_result blocks into a lookup map (cross-message pairing). */
export function collectToolResults(
  blocks: BlockLike[],
  into: Map<string, { content: string; isError?: boolean }> = new Map(),
): Map<string, { content: string; isError?: boolean }> {
  for (const b of blocks) {
    if (b.type === "tool_result" && b.tool_use_id) {
      into.set(b.tool_use_id, {
        content: normalizeToolResultContent(b.content),
        isError: b.is_error,
      });
    }
  }
  return into;
}

export function renderContentBlocks(
  blocks: unknown[] | undefined | Message,
  opts?: { hiddenToolNames?: ReadonlySet<string> },
) {
  // Unwrap Message object to its blocks array
  const resolved: unknown[] | undefined = Array.isArray(blocks)
    ? blocks
    : blocks && typeof blocks === "object" && "blocks" in blocks
      ? (blocks as Message).blocks
      : undefined;
  if (!Array.isArray(resolved)) return null;
  const typed = resolved as BlockLike[];
  const hidden = opts?.hiddenToolNames;

  const toolResults = collectToolResults(typed);

  return typed.map((block, i) => {
    if (
      block.type === "tool_use" &&
      block.id &&
      typeof block.name === "string" &&
      !hidden?.has(block.name)
    ) {
      const result = toolResults.get(block.id);
      return (
        <div key={block.id}>
          <ToolCallCard name={block.name} input={block.input} />
          {result && <ToolResultCard content={result.content} isError={result.isError} />}
        </div>
      );
    }
    if (block.type === "image" && typeof block.base64 === "string" && block.mediaType) {
      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={`img-${i}`}
          src={`data:${block.mediaType};base64,${block.base64}`}
          alt="attached image"
          className="my-1 max-h-80 rounded-md border border-(--hairline)"
        />
      );
    }
    return null;
  });
}
