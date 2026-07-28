import type { ChatModel } from "@my-agent-team/core";
import { collectStream } from "@my-agent-team/core";
import { definePlugin, type Plugin } from "@my-agent-team/agent";
import { extractText, type Message } from "@my-agent-team/message";
import { formatRecapPrompt } from "./prompt.js";

export interface RecapPluginOptions {
  recapModel: ChatModel;
  enabled?: boolean;
}

export function recapPlugin(opts: RecapPluginOptions): Plugin {
  const enabled = opts.enabled ?? true;
  let turnCount = 0;
  let lastReviewedMessageCount = 0;

  async function generateRecap(messages: readonly Message[]): Promise<string | null> {
    if (messages.length === 0) return null;
    const promptMsgs: Message[] = [
      ...messages,
      { role: "user", text: formatRecapPrompt(turnCount) },
    ];
    const { blocks } = await collectStream(opts.recapModel.stream(promptMsgs));
    const text = extractText({
      blocks: blocks.filter(
        (b): b is { type: "text"; text: string } => b.type === "text" && "text" in b,
      ),
    });
    return text.trim() || null;
  }

  return definePlugin({
    name: "recap",
    hooks: {
      async beforeRun(_ctx, messages: readonly Message[]): Promise<Message[]> {
        turnCount = 0;
        lastReviewedMessageCount = 0;
        return [...messages];
      },
      async afterModel(ctx, messages) {
        if (!enabled) return;
        turnCount++;
        // Only recap this loop's new messages, not the full history
        const newMessages = messages.slice(lastReviewedMessageCount);
        lastReviewedMessageCount = messages.length;
        const text = await generateRecap(newMessages);
        if (text) {
          ctx.emit?.({
            type: "recap_update",
            payload: { text, turn: turnCount },
          });
        }
      },
    },
  });
}
