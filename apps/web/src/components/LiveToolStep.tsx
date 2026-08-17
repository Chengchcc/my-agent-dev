"use client";

import { useState } from "react";
import type { LiveToolCall } from "@/lib/transient-reducer";

/** Transient live tool step shown inside a streaming assistant bubble.
 *  Live events carry no tool input, so nothing is fabricated — the step
 *  line shows the tool name and state; expanding reveals the raw result. */
export function LiveToolStep({ tool }: { tool: LiveToolCall }) {
  const [open, setOpen] = useState(false);

  const stateDot =
    tool.state === "running"
      ? "bg-[var(--primary)] animate-pulse"
      : tool.state === "error"
        ? "bg-red-400"
        : "bg-emerald-400";
  const stateLabel =
    tool.state === "running" ? "running" : tool.state === "error" ? "error" : "done";

  return (
    <div className="mt-1 min-w-0 rounded-md border border-(--hairline) bg-(--canvas-soft) px-2 py-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
      >
        <span className={`size-1.5  shrink-0 rounded-full ${stateDot}`} />
        <span className="min-w-0 truncate font-mono text-xs text-(--ink)">{tool.name}</span>
        <span className="text-[10px] text-(--mute)">{stateLabel}</span>
        {tool.result !== undefined && (
          <span className="ml-auto text-[10px] text-(--mute)">{open ? "hide" : "result"}</span>
        )}
      </button>
      {open && tool.result !== undefined && (
        <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-(--canvas) p-2 font-mono text-[10px] text-(--mute) wrap-anywhere">
          {typeof tool.result === "string" ? tool.result : JSON.stringify(tool.result, null, 2)}
        </pre>
      )}
    </div>
  );
}
