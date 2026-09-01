"use client";

import { useState } from "react";
import type { LiveToolCall } from "@/lib/transient-reducer";
import { LiveToolStep } from "./LiveToolStep";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";

interface TimelineTransientTraceProps {
  msgCount: number;
  thinking: string;
  tools: readonly LiveToolCall[];
  ordered?: ReadonlyArray<{ type: "text" | "thinking"; text: string }>;
}

/** Live trace for a streaming run: one `X messages · Y commands` summary
 *  row above the bubble, expanding into the streaming thinking (if any) and
 *  the live tool steps in appearance order. The transient data has no
 *  fine-grained text/tool interleaving, so no interleaving is fabricated —
 *  summary on top, thinking, tools in order, streaming text below. */
export function TimelineTransientTrace({
  msgCount,
  thinking,
  tools,
  ordered,
}: TimelineTransientTraceProps) {
  const [open, setOpen] = useState(false);

  // With an ordered list we render thinking AND text fragments interleaved
  // exactly as the stream produced them. Without it (legacy chunks) fall
  // back to thinking-on-top + tools, and the text stays in MessageBubble.
  const hasOrdered = ordered && ordered.length > 0;

  return (
    <div className="mb-0.5">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          className="flex w-full items-center gap-1.5 px-1 py-0.5 text-left
            text-[11px] font-mono text-(--mute)
            transition-colors hover:text-(--ink)"
        >
          <span className="shrink-0 text-(--primary)">{open ? "▼" : "▶"}</span>
          <span>
            {msgCount} messages · {tools.length} commands
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="my-0.5 ml-1.5 flex flex-col gap-0.5 border-l border-(--hairline) py-1 pl-2">
            {hasOrdered
              ? ordered
                  .filter((b) => b.type === "thinking")
                  .map((b, i) => (
                    <div
                      key={`${b.type}-${i}`}
                      className="px-1 py-0.5 text-[12px] italic text-(--mute)"
                    >
                      {b.text}
                    </div>
                  ))
              : thinking.trim() && (
                  <div className="px-1 py-0.5 text-[12px] italic text-(--mute)">{thinking}</div>
                )}
            {tools.map((tool) => (
              <LiveToolStep key={tool.callId} tool={tool} />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
