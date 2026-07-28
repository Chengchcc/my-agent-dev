import type { ChatModel } from "@my-agent-team/core";
import { collectStream } from "@my-agent-team/core";
import { extractText, type Message } from "@my-agent-team/message";
import { findCutPoint } from "./compaction/cut-point.js";
import { STRUCTURED_SUMMARY_PROMPT, UPDATE_SUMMARY_PROMPT } from "./compaction/prompts.js";
import { DEFAULT_SHAKE_CONFIG, shakeMessages } from "./compaction/shake.js";
import type { ContextManager } from "./context-manager.js";
import { repairToolPairs } from "../runtime/repair-tool-pairs.js";

export interface SummarizingOptions {
  triggerAt: number;
  /** Number of recent messages to keep. Ignored if keepRecentTokens is set. */
  keepRecent?: number;
  /** Token budget for recent messages — enables findCutPoint boundary-aware cutting. */
  keepRecentTokens?: number;
  summarizer?: (old: Message[], model: ChatModel) => Promise<Message>;
  summarizerModel?: ChatModel;
  countTokens?: (messages: readonly Message[]) => number | Promise<number>;
  /** Previous summary for iterative update (merges new messages into existing summary). */
  previousSummary?: string;
}

const APPROX_CHARS_PER_TOKEN = 4;

function approximateTokens(messages: readonly Message[]): number {
  return Math.ceil(JSON.stringify(messages).length / APPROX_CHARS_PER_TOKEN);
}

export async function defaultSummarize(
  old: Message[],
  model: ChatModel,
  signal?: AbortSignal,
): Promise<Message> {
  const promptMsgs: Message[] = [
    ...old,
    {
      role: "user",
      text: "Summarize the conversation above concisely. Keep key decisions, facts, and action items. Output only the summary text, no preamble.",
    },
  ];
  const { blocks } = await collectStream(model.stream(promptMsgs, { signal }));
  const text = extractText({ blocks: blocks as readonly { type: string; text?: string }[] });
  return { role: "user", text: `[Earlier conversation summary]: ${text}` };
}

/** Structured summarizer: OMP 8-section markdown format. */
export async function structuredSummarize(
  old: Message[],
  model: ChatModel,
  signal?: AbortSignal,
): Promise<Message> {
  const promptMsgs: Message[] = [...old, { role: "user", text: STRUCTURED_SUMMARY_PROMPT }];
  const { blocks } = await collectStream(model.stream(promptMsgs, { signal }));
  const text = extractText({ blocks: blocks as readonly { type: string; text?: string }[] });
  return { role: "user", text: `[Earlier conversation summary]:\n${text}` };
}

/** Iterative update: merge new messages into an existing summary. */
export async function updateSummarize(
  newMessages: Message[],
  previousSummary: string,
  model: ChatModel,
  signal?: AbortSignal,
): Promise<Message> {
  const promptMsgs: Message[] = [
    ...newMessages,
    {
      role: "user",
      text: [
        `<previous-summary>`,
        previousSummary,
        `</previous-summary>`,
        ``,
        UPDATE_SUMMARY_PROMPT,
      ].join("\n"),
    },
  ];
  const { blocks } = await collectStream(model.stream(promptMsgs, { signal }));
  const text = extractText({ blocks: blocks as readonly { type: string; text?: string }[] });
  return { role: "user", text: `[Earlier conversation summary]:\n${text}` };
}

export function autoSummarize(opts: SummarizingOptions): ContextManager {
  const keepRecent = opts.keepRecent;
  const keepRecentTokens = opts.keepRecentTokens;
  const triggerAt = opts.triggerAt;
  const summarizerModel = opts.summarizerModel;

  return {
    async shape(ctx, messages) {
      const counter = opts.countTokens ?? ctx.model.countTokens ?? approximateTokens;
      const total = await counter(messages);

      // Step 1: mechanically shake large tool results (no LLM call)
      const shaken = shakeMessages(messages, DEFAULT_SHAKE_CONFIG);
      const shakenTotal = await counter(shaken);
      if (shakenTotal <= triggerAt) return shaken;

      // Step 2: if shake wasn't enough, LLM summarize the rest
      const cutIdx = keepRecentTokens
        ? findCutPoint(shaken, keepRecentTokens)
        : keepRecent
          ? shaken.length - keepRecent
          : shaken.length;
      const old = shaken.slice(0, cutIdx);
      const recent = shaken.slice(cutIdx);

      if (old.length === 0) return shaken;
      const model = summarizerModel ?? ctx.model;

      let summary: Message;
      if (opts.summarizer) {
        summary = await opts.summarizer(old, model);
      } else if (opts.previousSummary) {
        summary = await updateSummarize(old, opts.previousSummary, model, ctx.signal);
      } else {
        summary = await structuredSummarize(old, model, ctx.signal);
      }

      // Reversible compaction
      const session = ctx.session;
      if (session) {
        const tokensBefore = typeof total === "number" ? total : 0;
        await session.appendCompaction(summary.text ?? "", "", tokensBefore);
        const built = await session.buildContext();
        return repairToolPairs(built.messages);
      }

      return repairToolPairs([summary, ...recent]);
    },
  };
}
