import { z } from "zod";

/** Shared schema for lark→backend message content.
 *
 *  Single source — lark-bot writes, backend validates, both import.
 *  Changing a field name here → tsc fails on both sides. */
export const larkContentSchema = z.object({
  text: z.string(),
  source: z.literal("lark"),
  larkEventId: z.string().min(1),
  larkMessageId: z.string().min(1),
});

export type LarkContent = z.infer<typeof larkContentSchema>;

/** Shared schema for LarkMessageEvent (lark-cli NDJSON event). */
export const larkMessageEventSchema = z.object({
  type: z.string(),
  event_id: z.string().min(1),
  timestamp: z.string(),
  id: z.string(),
  message_id: z.string().min(1),
  create_time: z.string(),
  chat_id: z.string().min(1),
  chat_type: z.enum(["p2p", "group"]),
  message_type: z.string(),
  sender_id: z.string().min(1),
  /** "user" | "app" | ... — absent in older lark-cli event dumps. When
   *  present, non-"user" senders (bots) must never drive an agent run
   *  (H7: bot-to-bot loops). */
  sender_type: z.string().optional(),
  content: z.string(),
  senderDisplayName: z.string().nullable().optional(),
});

export type LarkMessageEvent = z.infer<typeof larkMessageEventSchema>;
