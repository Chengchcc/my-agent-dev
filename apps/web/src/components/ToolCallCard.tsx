"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { inputPreview, toolIcon } from "./tool-icon";

/** Standalone tool_use rendered as a design card (`icon + name + inline args
 *  preview`). Used for tool calls outside a ReasoningTrace turn; the result
 *  pairs via a sibling ToolResultCard. */
export function ToolCallCard({ name, input }: { id?: string; name: string; input: unknown }) {
  const [open, setOpen] = useState(false);
  const Icon = toolIcon(name);
  const preview = inputPreview(input);

  return (
    <div className="overflow-hidden rounded-lg border border-(--hairline) bg-(--panel) shadow-sm">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          render={
            <Button
              variant="ghost"
              className="w-full justify-start gap-2 px-3 py-1.5 h-auto text-left hover:bg-(--panel2) hover:text-(--ink) transition-colors"
            />
          }
        >
          <Icon size={14} className="shrink-0 text-(--primary)" />
          <span className="min-w-0 truncate font-code-sm text-code-sm font-medium text-(--ink)">
            {name}
          </span>
          <span className="ml-auto shrink-0 font-label-caps text-label-caps uppercase text-(--mute)">
            {open ? "▲ hide" : "▼ args"}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          {/* Inline args preview — always visible, one line */}
          {preview && (
            <div className="flex items-center gap-1.5 border-t border-(--hairline) px-3 py-1.5">
              <span className="font-code-sm text-code-sm font-medium text-(--primary)">args:</span>
              <span className="min-w-0 truncate font-code-sm text-code-sm text-(--body)">
                {preview}
              </span>
            </div>
          )}
          {/* Full payload */}
          <div className="px-3 py-2">
            <pre className="max-h-40 overflow-x-auto whitespace-pre-wrap rounded bg-(--canvas-soft) p-2 text-[12px] leading-relaxed text-(--canvas-text-soft) wrap-anywhere">
              {JSON.stringify(input, null, 2)}
            </pre>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
