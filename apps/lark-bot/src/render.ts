import type { MessageRevision } from "@chengchenccc/message";
import { normalizeForLarkMarkdown } from "./markdown-normalizer.js";

/**
 * Render a parsed MessageRevision to plain text for Lark message sending.
 * Uses markdown normalizer for safe rendering (code fence closure, truncation).
 */
export function renderRevision(rev: MessageRevision): string {
  const raw = extractRawText(rev);
  const { markdown, truncated } = normalizeForLarkMarkdown(raw);
  return truncated ? `${markdown}\n\n[消息过长已截断]` : markdown;
}

function extractRawText(rev: MessageRevision): string {
  if (rev.text) return rev.text;
  if (rev.blocks && rev.blocks.length > 0) {
    const texts = rev.blocks
      .filter(
        (b): b is { type: "text"; text: string } =>
          typeof b === "object" && b !== null && (b as { type: string }).type === "text",
      )
      .map((b) => b.text);
    if (texts.length > 0) return texts.join("");
  }
  return "[Unsupported content]";
}
