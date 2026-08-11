"use client";

import { useState } from "react";
import type { TurnSegment } from "@/lib/conversation-reducer";
import { collectToolResults, renderContentBlocks } from "@/lib/render-blocks";
import { extractText } from "@/lib/timeline";
import { MessageBubble } from "./MessageBubble";
import { ToolStep } from "./ToolStep";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";

/** todo_write has its own TodoPanel — never repeat it in the tool trace. */
const HIDDEN_TOOLS = new Set(["todo_write"]);

function isVisibleToolBlock(b: { type?: string; name?: string }): boolean {
  return b.type === "tool_use" && !HIDDEN_TOOLS.has(b.name ?? "");
}

export function ReasoningTrace({
  segment,
  defaultOpen = false,
}: {
  segment: Extract<TurnSegment, { kind: "turn" }>;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const { rounds, conclusion, sender } = segment;

  // Cross-message tool_result aggregation
  const resultMap = new Map<string, { content: string; isError?: boolean }>();
  for (const m of rounds) {
    const blocks = m.content.blocks;
    if (Array.isArray(blocks)) collectToolResults(blocks, resultMap);
  }

  const stepCount = rounds.reduce(
    (n, m) =>
      n +
      (Array.isArray(m.content.blocks)
        ? m.content.blocks.filter((b) => isVisibleToolBlock(b)).length
        : 0),
    0,
  );
  const toolNames = [
    ...new Set(
      rounds.flatMap((m) =>
        Array.isArray(m.content.blocks)
          ? m.content.blocks
              .filter((b) => isVisibleToolBlock(b))
              .map((b) => (b as { name?: string }).name ?? "")
          : [],
      ),
    ),
  ].filter(Boolean);

  return (
    <div className="my-1">
      {rounds.length > 0 && (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger
            className="w-full text-left flex items-center gap-2 px-3 py-1.5
            border border-[var(--hairline)] rounded-md hover:bg-[var(--canvas-soft)] transition-colors
            text-[11px] font-[family-name:var(--font-mono)] text-[var(--mute)]"
          >
            <span className="text-[var(--primary)]">{open ? "▼" : "▶"}</span>
            <span>
              Reasoning trace · {stepCount} steps
              {toolNames.length ? ` · ${toolNames.join(", ")}` : ""}
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="border-l-2 border-[var(--primary)]/30 ml-1.5 pl-3 py-1 my-1 flex flex-col gap-1.5">
              {rounds.map((m) => {
                const blocks = m.content.blocks;
                if (!Array.isArray(blocks)) return null;
                const text = extractText(m.content);
                return (
                  <div key={m.id} className="flex flex-col gap-1">
                    {text && <div className="text-[13px] text-[var(--body)]">{text}</div>}
                    {blocks.map((b) =>
                      b.type === "tool_use" && b.id && !HIDDEN_TOOLS.has(b.name ?? "") ? (
                        <ToolStep
                          key={b.id}
                          name={b.name ?? ""}
                          input={b.input}
                          result={resultMap.get(b.id)}
                        />
                      ) : null,
                    )}
                  </div>
                );
              })}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
      {/* Conclusion: always visible, full-width */}
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
          {renderContentBlocks(conclusion.content, { hiddenToolNames: HIDDEN_TOOLS })}
        </div>
      )}
    </div>
  );
}
