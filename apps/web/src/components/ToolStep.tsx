"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { normalizeToolResultContent } from "@/lib/render-blocks";

export function ToolStep({
  name,
  input,
  result,
}: {
  name: string;
  input: unknown;
  result?: { content: string; isError?: boolean };
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="font-[family-name:var(--font-mono)] text-[12px]">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          render={
            <Button
              variant="ghost"
              className="w-full justify-start gap-2 px-2 py-1 h-auto
                text-left text-[var(--mute)]
                hover:bg-[var(--canvas-soft)]
                hover:text-[var(--ink)]
                transition-colors"
            />
          }
        >
          <span className="shrink-0 text-[var(--primary)]">→</span>
          <span className="truncate text-[var(--primary)]">{name}</span>
          <span className="ml-auto shrink-0 text-[10px] text-[var(--mute)]">
            {open ? "▲ collapse" : "▼ expand"}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="pl-4 mt-1 flex flex-col gap-1">
            <pre className="max-h-40 overflow-x-auto whitespace-pre-wrap rounded bg-[var(--canvas-soft)] p-2 text-[12px] leading-relaxed text-[var(--canvas-text-soft)]">
              {JSON.stringify(input, null, 2)}
            </pre>
            {result && (
              <pre
                className={`max-h-40 overflow-x-auto whitespace-pre-wrap rounded bg-[var(--canvas-soft)] p-2 text-[12px] leading-relaxed ${
                  result.isError ? "text-red-400" : "text-[var(--canvas-text-soft)]"
                }`}
              >
                {"⤷ "}
                {normalizeToolResultContent(result.content)}
              </pre>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
