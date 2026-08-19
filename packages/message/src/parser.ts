import { z } from "zod";
import type { MessageRevision } from "./revision.js";

// ─── Zod schemas ──────────────────────────────────────────────

export const TextBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const ThinkingBlockSchema = z.object({
  type: z.literal("thinking"),
  text: z.string(),
  signature: z.string().optional(),
  redacted: z.boolean().optional(),
});

export const ToolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown(),
});
export const ImageBlockSchema = z.object({
  type: z.literal("image"),
  mediaType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  base64: z.string().min(1),
});

export const ToolResultBlockSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string().min(1),
  content: z.string(),
  is_error: z.boolean().optional(),
  images: z.array(ImageBlockSchema).optional(),
});
// M17.3 fix: accept unknown block types via passthrough, so legacy or future
// block variants don't cause parse failures. The discriminatedUnion covers known
// types; the passthrough fallback keeps the rest.
export const ContentBlockSchema = z
  .discriminatedUnion("type", [
    TextBlockSchema,
    ThinkingBlockSchema,
    ToolUseBlockSchema,
    ToolResultBlockSchema,
    ImageBlockSchema,
  ])
  .or(z.object({ type: z.string() }).passthrough());

// ─── Message sub-type schemas ─────────────────────────────────

export const MessageRoleSchema = z.enum(["system", "user", "assistant", "tool"]);
export const MessageStateSchema = z.enum(["pending", "streaming", "waiting", "done", "error"]);

export const MessageToolStateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  state: z.enum(["running", "done", "error"]),
  isError: z.boolean().optional(),
});

export const MessageErrorSchema = z.object({
  code: z.string().optional(),
  message: z.string().min(1),
});

export const MessageAuthorSchema = z.object({
  kind: z.enum(["system", "user", "agent", "tool"]),
  id: z.string().optional(),
  displayName: z.string().optional(),
});

// ─── Domain schemas ───────────────────────────────────────────

export const MessageSchema = z.object({
  id: z.string().optional(),
  role: MessageRoleSchema,
  author: MessageAuthorSchema.optional(),
  state: MessageStateSchema.optional(),
  text: z.string().optional(),
  blocks: z.array(ContentBlockSchema).optional(),
  tools: z.array(MessageToolStateSchema).optional(),
  conversationId: z.string().optional(),
  visibility: z.enum(["internal", "conversation"]).optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
  error: MessageErrorSchema.optional(),
  runStatus: z.enum(["running", "retrying", "compacting", "waiting"]).optional(),
});

export const MessageRevisionSchema = z.object({
  messageId: z.string().min(1),
  state: MessageStateSchema,
  role: MessageRoleSchema,
  // M17.3 fix: .nullable() tolerates explicit null in legacy rows (old hand-written
  // parser accepted null→undefined; zod rejects null for .optional() by default)
  text: z.string().nullable().optional(),
  blocks: z.array(ContentBlockSchema).nullable().optional(),
  tools: z.array(MessageToolStateSchema).nullable().optional(),
  conversationId: z.string().nullable().optional(),
  visibility: z.enum(["internal", "conversation"]).nullable().optional(),
  updatedAt: z.number(),
  error: MessageErrorSchema.nullable().optional(),
  runStatus: z.enum(["running", "retrying", "compacting", "waiting"]).nullable().optional(),
});

// ─── Public API (backward-compatible signatures, zod inside) ──

export class MessageParseError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(`Message parse error: ${message} (field: ${field})`);
    this.name = "MessageParseError";
  }
}

/** Strictly parse and validate a MessageRevision. Throws MessageParseError on failure.
 *  M17.3: Internal implementation uses zod; external signature unchanged. */
export function parseMessageRevision(input: unknown): MessageRevision {
  const result = MessageRevisionSchema.safeParse(input);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path.join(".") ?? "(root)";
    throw new MessageParseError(path, first?.message ?? "invalid");
  }
  return result.data as MessageRevision;
}

/** Safe parse — returns success/error instead of throwing. M17.3 new addition. */
export function safeParseMessageRevision(
  input: unknown,
): z.SafeParseReturnType<unknown, MessageRevision> {
  return MessageRevisionSchema.safeParse(input) as z.SafeParseReturnType<unknown, MessageRevision>;
}

/** Serialize a MessageRevision to JSON, validating via parse first. */
export function serializeMessageRevision(revision: MessageRevision): string {
  const validated = parseMessageRevision(revision);
  return JSON.stringify(validated);
}
