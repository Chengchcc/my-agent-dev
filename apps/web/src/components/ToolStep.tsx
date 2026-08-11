"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { normalizeToolResultContent } from "@/lib/render-blocks";

/** Single tool invocation detail. Input and result fold independently;
 *  a call with no result shows no result toggle. */
export function ToolStep({
  name,
  input,
  result,
}: {
  name: string;
  input: unknown;
  result?: { content: string; isError?: boolean };
}) {
  const [inputOpen, setInputOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
  return (
    <div className="font-mono text-[12px]">
      <div className="flex items-center gap-2 px-2 py-1">
        <span className="shrink-0 text-(--primary)">→</span>
        <span className="truncate text-(--primary)">{name}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            type="button"
            onClick={() => setInputOpen((v) => !v)}
            className="h-auto px-1.5 py-0 text-[10px] text-[var(--mute)] hover:bg-transparent hover:text-[var(--ink)]"
          >
            {inputOpen ? "▲ input" : "▼ input"}
          </Button>
          {result && (
            <Button
              variant="ghost"
              type="button"
              onClick={() => setResultOpen((v) => !v)}
              className="h-auto px-1.5 py-0 text-[10px] text-[var(--mute)] hover:bg-transparent hover:text-[var(--ink)]"
            >
              {resultOpen ? "▲ result" : "▼ result"}
            </Button>
          )}
        </span>
      </div>
      {inputOpen && (
        <pre className="max-h-40 overflow-x-auto whitespace-pre-wrap rounded bg-[var(--canvas-soft)] p-2 text-[12px] leading-relaxed text-[var(--canvas-text-soft)]">
          {JSON.stringify(input, null, 2)}
        </pre>
      )}
      {resultOpen && result && (
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
  );
}
