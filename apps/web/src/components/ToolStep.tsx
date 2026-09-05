"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { normalizeToolResultContent } from "@/lib/render-blocks";
import { inputPreview, toolIcon } from "./tool-icon";

/** Single tool invocation rendered as a design card (`icon + name + status +
 *  inline args preview`), matching the Obsidian chat anatomy. The args are
 *  visible at a glance; fold reveals the full payload and result. */
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
  const hasResult = !!result;
  const status = result?.isError ? "error" : hasResult ? "done" : "running";
  const Icon = toolIcon(name);
  const preview = inputPreview(input);

  const statusStyle =
    status === "error"
      ? "border-(--err)/30 bg-(--err)/10 text-(--err)"
      : status === "done"
        ? "border-(--ok)/30 bg-(--ok)/10 text-(--ok)"
        : "border-(--primary)/30 bg-(--primary)/10 text-(--primary)";
  const edgeStyle =
    status === "error" ? "bg-(--err)" : status === "done" ? "bg-(--ok)" : "bg-(--primary)";

  return (
    <div className="overflow-hidden rounded-lg border border-(--hairline) bg-(--panel) shadow-sm">
      {/* Header: icon + name + status + folds */}
      <div className="flex items-center gap-2 px-3 py-1.5">
        <Icon size={14} className="shrink-0 text-(--primary)" />
        <span className="min-w-0 truncate font-code-sm text-code-sm font-medium text-(--ink)">
          {name}
        </span>
        <span
          className={`shrink-0 rounded border px-1.5 py-0.5 font-label-caps text-label-caps font-bold uppercase ${statusStyle}`}
        >
          {status}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            type="button"
            onClick={() => setInputOpen((v) => !v)}
            className="h-auto px-1.5 py-0 text-[10px] font-mono text-(--mute) hover:bg-transparent hover:text-(--ink)"
          >
            {inputOpen ? "▲ input" : "▼ input"}
          </Button>
          {hasResult && (
            <Button
              variant="ghost"
              type="button"
              onClick={() => setResultOpen((v) => !v)}
              className="h-auto px-1.5 py-0 text-[10px] font-mono text-(--mute) hover:bg-transparent hover:text-(--ink)"
            >
              {resultOpen ? "▲ result" : "▼ result"}
            </Button>
          )}
        </span>
      </div>

      {/* Inline args preview — always visible, one line */}
      {preview && (
        <div className="flex items-center gap-1.5 border-t border-(--hairline)/60 px-3 py-1.5">
          <span className="font-code-sm text-code-sm font-medium text-(--primary)">args:</span>
          <span className="min-w-0 truncate font-code-sm text-code-sm text-(--body)">
            {preview}
          </span>
        </div>
      )}

      {/* Coloured status edge */}
      <span className={`absolute inset-y-0 left-0 w-0.5 ${edgeStyle}`} aria-hidden />

      {/* Full input payload */}
      {inputOpen && (
        <div className="border-t border-(--hairline) px-3 py-2">
          <pre className="mt-1 max-h-40 overflow-x-auto whitespace-pre-wrap rounded bg-(--canvas-soft) p-2 text-[12px] leading-relaxed text-(--canvas-text-soft) wrap-anywhere">
            {JSON.stringify(input, null, 2)}
          </pre>
        </div>
      )}
      {/* Result payload */}
      {resultOpen && result && (
        <div className="border-t border-(--hairline) px-3 py-2">
          <pre
            className={`max-h-40 overflow-x-auto whitespace-pre-wrap rounded bg-(--canvas-soft) p-2 text-[12px] leading-relaxed wrap-anywhere ${
              result.isError ? "text-red-400" : "text-(--canvas-text-soft)"
            }`}
          >
            {"⤷ "}
            {normalizeToolResultContent(result.content)}
          </pre>
        </div>
      )}
    </div>
  );
}
