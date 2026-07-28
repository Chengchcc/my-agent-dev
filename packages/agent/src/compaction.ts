import type { ChatModel } from "@my-agent-team/core";
import { collectStream } from "@my-agent-team/core";
import type { Message } from "@my-agent-team/message";
import type { Checkpointer } from "./persistence/checkpointer.js";

export interface CompactionOptions {
  model: ChatModel;
  checkpointer: Checkpointer;
  sessionId: string;
  keepRecent?: number;
  customInstructions?: string;
  signal?: AbortSignal;
}

export interface CompactionResult {
  originalCount: number;
  compactedCount: number;
  summaryLength: number;
  messageCount?: number;
}

/**
 * Compact a thread by summarizing old messages and keeping recent ones.
 * Returns the compacted messages (does NOT save — caller decides).
 */
export async function compactThread(opts: CompactionOptions): Promise<{
  messages: Message[];
  result: CompactionResult;
}> {
  const keepRecent = opts.keepRecent ?? 10;
  const allMessages = (await opts.checkpointer.load(opts.sessionId)) ?? [];

  if (allMessages.length <= keepRecent) {
    return {
      messages: allMessages,
      result: {
        originalCount: allMessages.length,
        compactedCount: allMessages.length,
        summaryLength: 0,
      },
    };
  }

  const toSummarize = allMessages.slice(0, -keepRecent);
  const recent = allMessages.slice(-keepRecent);

  const summaryText = await summarizeMessages(
    toSummarize,
    opts.model,
    opts.customInstructions,
    opts.signal,
  );
  const summaryMessage: Message = {
    role: "user",
    text: summaryText,
  };

  const compacted = [summaryMessage, ...recent];

  return {
    messages: compacted,
    result: {
      originalCount: allMessages.length,
      compactedCount: compacted.length,
      summaryLength: summaryText.length,
    },
  };
}

async function summarizeMessages(
  messages: Message[],
  model: ChatModel,
  customInstructions?: string,
  signal?: AbortSignal,
): Promise<string> {
  const instruction =
    customInstructions ??
    [
      "Summarize the conversation above in a structured format with five sections.",
      "Leave a section empty if there is no content for it. Format:",
      "",
      "## 目标 (Goals)",
      "What the user or agent is currently trying to accomplish.",
      "",
      "## 约束 (Constraints)",
      "Hard boundaries, limitations, or rules that affect decisions.",
      "",
      "## 进度 (Progress)",
      "What has been completed so far, including specific results.",
      "",
      "## 关键决策 (Key Decisions)",
      "Important choices made and their rationale.",
      "",
      "## 下一步 (Next Steps)",
      "Remaining work and the immediate next action to take.",
    ].join("\n");
  const prompt: Message = {
    role: "user",
    text: `<task>${instruction}</task>\n\n<conversation>\n${formatMessages(messages)}\n</conversation>`,
  };

  const stream = model.stream([prompt], { signal });
  const collected = await collectStream(stream);
  const text = collected.blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return text || "(summary unavailable)";
}

function formatMessages(messages: Message[]): string {
  return messages
    .map((m) => {
      const text =
        m.text ??
        m.blocks
          ?.filter((b) => b.type === "text")
          .map((b) => (b as { type: "text"; text: string }).text)
          .join(" ") ??
        "";
      return `[${m.role}]: ${text}`;
    })
    .join("\n");
}
