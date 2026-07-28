import type { Tool } from "@my-agent-team/core";
import { defineContext, definePlugin, type Plugin } from "@my-agent-team/agent";
import type { Message } from "@my-agent-team/message";

export interface ConversationContextPluginOptions {
  /** Tools to register — created by the caller with conversation closures. */
  tools: Tool[];
}

/** Per-run conversation metadata. */
export interface ConversationContext {
  id: string;
  surface: string;
  senderName: string;
  input: string;
}

/** Context key for per-run conversation metadata.
 *  Caller writes via `session.setContext(ConversationCtx, data)`,
 *  plugin reads via `ConversationCtx.get(ctx)`. */
export const ConversationCtx = defineContext<ConversationContext>("conversation");

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * ConversationContextPlugin — injects conversation context into agent runs.
 *
 * Reads per-run conversation metadata via `ConversationCtx.get(ctx)`.
 * The caller writes via `AgentSession.setContext(ConversationCtx, data)`
 * before calling prompt(). The framework forwards the store to ctx at run start.
 */
/** Context key for conversation context XML. Plugin writes, metaContext reads. */
export const ConversationContextKey = defineContext<string>("conversation-context-xml");

export function conversationContextPlugin(opts: ConversationContextPluginOptions): Plugin {
  return definePlugin({
    name: "conversation-context",
    tools: opts.tools,
    hooks: {
      async beforeModel(ctx, messages: Message[]): Promise<Message[]> {
        const conv = ConversationCtx.get(ctx);
        if (!conv?.id) return messages;
        // Write to context store for metaContext to pick up.
        ctx.context.set(
          ConversationContextKey,
          `<conversation>
  <id>${escapeXml(conv.id)}</id>
  <surface>${escapeXml(conv.surface)}</surface>
  <trigger>
    <from>${escapeXml(conv.senderName)}</from>
    <message>${escapeXml(conv.input)}</message>
  </trigger>
</conversation>`,
        );
        return messages;
      },
    },
  });
}
