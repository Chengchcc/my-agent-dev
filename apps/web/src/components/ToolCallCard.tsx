"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

/** Tool call rendered as a slim trace row (`→ name ▼ expand`), not a CTA —
 *  matches ToolStep. Expanding reveals the tool input. */
export function ToolCallCard({ name, input }: { id?: string; name: string; input: unknown }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="font-mono text-[12px]">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          render={
            <Button
              variant="ghost"
              className="w-full justify-start gap-2 px-2 py-1 h-auto
                text-left text-(--mute)
                hover:bg-(--canvas-soft)
                hover:text-(--ink)
                transition-colors"
            />
          }
        >
          <span className="shrink-0 text-(--primary)">→</span>
          <span className="truncate text-(--primary)">{name}</span>
          <span className="ml-auto shrink-0 text-[10px] text-(--mute)">
            {open ? "▲ collapse" : "▼ expand"}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="pl-4 mt-1 flex flex-col gap-1">
            <pre className="max-h-40 overflow-x-auto whitespace-pre-wrap rounded bg-(--canvas-soft) p-2 text-[12px] leading-relaxed text-(--canvas-text-soft)">
              {JSON.stringify(input, null, 2)}
            </pre>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
