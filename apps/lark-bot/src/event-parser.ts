import type { LarkMessageEvent } from "@chengchenccc/api-contract";
import { larkMessageEventSchema } from "@chengchenccc/api-contract";

export type { LarkMessageEvent };

/**
 * Parse a Lark NDJSON event line using the shared zod schema (single source).
 * Replaces the old hand-rolled narrow with safeParse.
 */
export function parseEvent(line: string): LarkMessageEvent | null {
  try {
    const raw = JSON.parse(line);
    const result = larkMessageEventSchema.safeParse(raw);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Check if the message content contains @mention of the bot by display name.
 *  Relies on lark-cli's Process hook having resolved mention keys to @name in content text. */
export function isBotMentioned(content: string, botDisplayName: string): boolean {
  return content.includes(`@${botDisplayName}`);
}
