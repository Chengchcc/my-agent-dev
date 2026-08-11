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

type CanonicalToolCall = {
  id: string;
  name: string;
  input: unknown;
  result?: { content: string; isError?: boolean };
};

type CanonicalToolGroup = {
  name: string;
  items: CanonicalToolCall[];
  count: number;
};

/** Completed-turn trace: a light `X messages · Y commands` summary row above
 *  the final conclusion, expanding into per-tool-name groups of calls. */
export function ReasoningTrace({
  segment,
  defaultOpen = false,
}: {
  segment: Extract<TurnSegment, { kind: "turn" }>;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set());
  const { rounds, conclusion, sender } = segment;

  // Cross-message tool_result aggregation (rounds + conclusion).
  const resultMap = new Map<string, { content: string; isError?: boolean }>();
  for (const m of [...rounds, ...(conclusion ? [conclusion] : [])]) {
    const blocks = m.content.blocks;
    if (Array.isArray(blocks)) collectToolResults(blocks, resultMap);
  }

  // Visible tool_use across the whole turn (rounds + conclusion), in original
  // order (todo_write excluded). The final message commonly carries both the
  // tool calls and the answer text, so the conclusion's blocks count too.
  const toolCalls: CanonicalToolCall[] = [];
  for (const m of [...rounds, ...(conclusion ? [conclusion] : [])]) {
    const blocks = m.content.blocks;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) {
      if (b.type === "tool_use" && b.id && !HIDDEN_TOOLS.has(b.name ?? "")) {
        toolCalls.push({
          id: b.id,
          name: b.name ?? "",
          input: b.input,
          result: resultMap.get(b.id),
        });
      }
    }
  }

  // Assistant messages in this turn: the working rounds plus the conclusion.
  const msgCount = rounds.length + (conclusion ? 1 : 0);

  // Group by tool name, first-appearance order.
  const groups: CanonicalToolGroup[] = [];
  const groupIndex = new Map<string, number>();
  for (const c of toolCalls) {
    let i = groupIndex.get(c.name);
    if (i === undefined) {
      i = groups.length;
      groupIndex.set(c.name, i);
      groups.push({ name: c.name, items: [], count: 0 });
    }
    const g = groups[i]!;
    g.items.push(c);
    g.count += 1;
  }

  const toggleGroup = (name: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  return (
    <div className="my-1">
      {(rounds.length > 0 || toolCalls.length > 0) && (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger
            className="flex w-full items-center gap-1.5 px-1 py-0.5 text-left
              text-[11px] font-[family-name:var(--font-mono)] text-[var(--mute)]
              transition-colors hover:text-[var(--ink)]"
          >
            <span className="shrink-0 text-[var(--primary)]">{open ? "▼" : "▶"}</span>
            <span>
              {msgCount} messages · {toolCalls.length} commands
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="my-0.5 ml-1.5 flex flex-col gap-0.5 border-l border-[var(--hairline)] py-1 pl-2">
              {rounds.map((m) => {
                const text = extractText(m.content);
                return text ? (
                  <div key={m.id} className="px-1 py-0.5 text-[12px] text-[var(--body)]">
                    {text}
                  </div>
                ) : null;
              })}
              {groups.map((g) => (
                <div key={g.name}>
                  <button
                    type="button"
                    onClick={() => toggleGroup(g.name)}
                    className="flex w-full items-center gap-1.5 px-1 py-0.5 text-left
                      text-[11px] font-[family-name:var(--font-mono)] text-[var(--mute)]
                      transition-colors hover:text-[var(--ink)]"
                  >
                    <span className="shrink-0 text-[var(--primary)]">
                      {openGroups.has(g.name) ? "▼" : "▶"}
                    </span>
                    <span>
                      {g.count} commands · {g.name} ×{g.count}
                    </span>
                  </button>
                  {openGroups.has(g.name) && (
                    <div className="ml-2 flex flex-col">
                      {g.items.map((c) => (
                        <ToolStep key={c.id} name={c.name} input={c.input} result={c.result} />
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
      {/* Conclusion: always visible, full-width, never folded into the trace.
       * Tool calls of the turn live in the trace above; only the answer text
       * is rendered here (flat tool cards were the old layout). */}
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
