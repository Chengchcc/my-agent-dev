"use client";

import { Brain } from "lucide-react";
import { useState } from "react";
import type { TurnSegment } from "@/lib/conversation-reducer";
import { collectToolResults } from "@/lib/render-blocks";
import { extractText } from "@/lib/timeline";
import { Markdown } from "./Markdown";
import { MessageBubble } from "./MessageBubble";
import { ToolStep } from "./ToolStep";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";

/** todo_write has its own TodoPanel — never repeat it in the tool trace. */
const HIDDEN_TOOLS = new Set(["todo_write"]);

/** Per-turn reasoning trace (Obsidian anatomy):
 *  - each round renders its `thinking` as a collapsed Trace, then its
 *    narrative `text` as a visible bubble, then its tool_use as design cards.
 *  - the conclusion renders as a visible bubble, never folded in.
 *  Tool results pair to their tool_use via cross-message resultMap; `tool`
 *  role rounds only supply results, never a standalone row. */
export function ReasoningTrace({
  segment,
  defaultOpen = false,
  showSender = false,
  isLast = false,
}: {
  segment: Extract<TurnSegment, { kind: "turn" }>;
  defaultOpen?: boolean;
  showSender?: boolean;
  isLast?: boolean;
}) {
  const [openTrace, setOpenTrace] = useState(defaultOpen);
  const { rounds, conclusion, sender } = segment;

  // Cross-message tool_result aggregation (rounds + conclusion).
  const resultMap = new Map<string, { content: string; isError?: boolean }>();
  for (const m of [...rounds, ...(conclusion ? [conclusion] : [])]) {
    const blocks = m.content.blocks;
    if (Array.isArray(blocks)) collectToolResults(blocks, resultMap);
  }

  const name = sender.displayName ?? sender.memberId;

  // Render one round: a collapsed thinking trace (if any), the round's
  // narrative text as a bubble (deduped — .text equals the text block), then
  // each tool_use as a ToolStep card. Tool-only rounds render just cards.
  const roundBlocks = rounds.map((m) => {
    const blocks = m.content.blocks ?? [];
    const thinking = blocks.filter(
      (b): b is { type: "thinking"; text: string } => b.type === "thinking",
    );
    const tools = blocks.filter(
      (b): b is { type: "tool_use"; id: string; name: string; input: unknown } =>
        b.type === "tool_use" && !!b.id && !HIDDEN_TOOLS.has(b.name ?? ""),
    );
    // Narrative text: prefer the .text field (source of truth for content),
    // fall back to joining the text blocks.
    const narrative =
      extractText(m.content) ||
      blocks
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join(" ")
        .trim();
    return { m, thinking, narrative, tools };
  });

  return (
    <div className="my-1 space-y-2">
      {roundBlocks.map(({ m, thinking, narrative, tools }, idx) => {
        // The whole turn is one sender group. Only the first rendered bubble
        // carries the sender marker; only the last rendered bubble carries the
        // timestamp. The conclusion, when present, is always the last.
        const isGroupFirst = showSender && idx === 0;
        const isGroupLast = isLast && !conclusion && idx === roundBlocks.length - 1;
        return (
          <div key={m.id} className="min-w-0 w-full space-y-1.5">
            {/* Thinking — a single muted line, expand to reveal the reasoning.
                Deliberately light: it must never compete with the narrative or
                tool cards for visual weight. */}
            {thinking.length > 0 && (
              <Collapsible open={openTrace} onOpenChange={setOpenTrace}>
                <CollapsibleTrigger className="group flex w-full items-center gap-1.5 px-1 py-0.5 text-left">
                  <Brain size={12} className="shrink-0 text-(--accent-violet)/60" />
                  <span className="font-code-sm text-code-sm text-(--accent-violet)/70 group-hover:text-(--accent-violet)">
                    thinking
                  </span>
                  <span className="font-label-caps text-label-caps uppercase text-(--faint) transition-colors group-hover:text-(--mute)">
                    {openTrace ? "▴" : "▾"}
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="ml-1.5 mt-0.5 flex flex-col gap-1 border-l border-(--hairline) py-1 pl-3">
                    {thinking.map((b, bi) => (
                      <div key={`${m.id}:think:${bi}`}>
                        <span className="text-(--primary)">&gt;</span>{" "}
                        <Markdown text={b.text} tone="muted" />
                      </div>
                    ))}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )}

            {/* Narrative text — visible bubble */}
            {narrative && (
              <MessageBubble
                align="left"
                name={name}
                kind="agent"
                content={narrative}
                showSender={isGroupFirst}
                isFirst={isGroupFirst}
                isLast={isGroupLast}
              />
            )}

            {/* Tool calls — design cards */}
            {tools.length > 0 && (
              <div className="min-w-0 w-full space-y-1.5">
                {tools.map((t) => (
                  <ToolStep key={t.id} name={t.name} input={t.input} result={resultMap.get(t.id)} />
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* Conclusion: always visible, full-width, never folded into the trace.
          It's the group end (timestamp). It carries the marker only if no
          narrative round was rendered before it. */}
      {conclusion && (
        <MessageBubble
          align="left"
          name={name}
          kind="agent"
          content={
            extractText(conclusion.content) ||
            (typeof conclusion.content === "string" ? conclusion.content : "")
          }
          showSender={showSender && !roundBlocks.some((r) => r.narrative)}
          isLast={isLast}
        />
      )}
    </div>
  );
}
