"use client";

import { useState } from "react";
import type { TurnSegment } from "@/lib/conversation-reducer";
import { collectToolResults } from "@/lib/render-blocks";
import { extractText } from "@/lib/timeline";
import { MessageBubble } from "./MessageBubble";
import { ToolStep } from "./ToolStep";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";

/** todo_write has its own TodoPanel — never repeat it in the tool trace. */
const HIDDEN_TOOLS = new Set(["todo_write"]);

/** Completed-turn trace: a light `X messages · Y commands` summary row above
 *  the final conclusion, expanding into the chronological reasoning steps —
 *  intermediate assistant texts and tool calls in the order they happened.
 *  Tool results stay in their ToolStep result toggle via cross-message
 *  pairing (resultMap); `tool` role rounds only supply results, never a row. */
export function ReasoningTrace({
  segment,
  defaultOpen = false,
}: {
  segment: Extract<TurnSegment, { kind: "turn" }>;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const { rounds, conclusion, sender } = segment;

  // Cross-message tool_result aggregation (rounds + conclusion).
  const resultMap = new Map<string, { content: string; isError?: boolean }>();
  for (const m of [...rounds, ...(conclusion ? [conclusion] : [])]) {
    const blocks = m.content.blocks;
    if (Array.isArray(blocks)) collectToolResults(blocks, resultMap);
  }

  // Visible tool_use across the working rounds, in original order
  // (todo_write excluded). The conclusion's blocks are NOT part of the
  // trace process (ADR 0017: tool calls live in rounds, never in the
  // final answer).
  const visibleToolCount = rounds.reduce((n, m) => {
    const blocks = m.content.blocks;
    if (!Array.isArray(blocks)) return n;
    return (
      n +
      blocks.filter((b) => b.type === "tool_use" && b.id && !HIDDEN_TOOLS.has(b.name ?? "")).length
    );
  }, 0);

  // Assistant messages in this turn: the working rounds plus the conclusion.
  const msgCount = rounds.length + (conclusion ? 1 : 0);

  return (
    <div className="my-1">
      {(rounds.length > 0 || visibleToolCount > 0) && (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger
            className="flex w-full items-center gap-1.5 px-1 py-0.5 text-left
              text-[11px] font-mono text-(--mute)
              transition-colors hover:text-(--ink)"
          >
            <span className="shrink-0 text-(--primary)">{open ? "▼" : "▶"}</span>
            <span>
              {msgCount} messages · {visibleToolCount} commands
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="my-0.5 ml-1.5 flex flex-col gap-0.5 border-l border-(--hairline) py-1 pl-2">
              {rounds.map((m) => {
                // Tool results render inside their ToolStep result toggle,
                // never as a standalone round line (their text field is the
                // raw JSON payload).
                if (m.content.role === "tool") return null;
                const text = extractText(m.content);
                const blocks = m.content.blocks ?? [];
                return (
                  <div key={m.id} className="flex flex-col gap-0.5">
                    {text && <div className="px-1 py-0.5 text-[12px] text-(--body)">{text}</div>}
                    {blocks.map((b, bi) => {
                      if (b.type === "thinking") {
                        return (
                          <div
                            key={`${m.id}:think:${bi}`}
                            className="px-1 py-0.5 text-[12px] italic text-(--mute)"
                          >
                            {b.text}
                          </div>
                        );
                      }
                      if (b.type === "tool_use" && b.id && !HIDDEN_TOOLS.has(b.name ?? "")) {
                        return (
                          <ToolStep
                            key={b.id}
                            name={b.name ?? ""}
                            input={b.input}
                            result={resultMap.get(b.id)}
                          />
                        );
                      }
                      return null;
                    })}
                  </div>
                );
              })}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
      {/* Conclusion: always visible, full-width, never folded into the trace. */}
      {conclusion && (
        <div>
          <MessageBubble
            align="left"
            name={sender.displayName ?? sender.memberId}
            kind="agent"
            content={
              extractText(conclusion.content) ||
              (typeof conclusion.content === "string" ? conclusion.content : "")
            }
          />
        </div>
      )}
    </div>
  );
}
