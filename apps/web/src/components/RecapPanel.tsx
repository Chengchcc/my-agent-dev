"use client";

import type { SenderRef } from "@/lib/conversation-reducer";

/** Per-run recap summaries pinned above the conversation timeline.
 *  Shows the latest one-line summary from the active run's cheap-model
 *  recap. Empty → renders nothing. */
export function RecapPanel({
  runs,
}: {
  runs: Array<{ runId: string; agent: SenderRef | null; text: string; turn: number }>;
}) {
  const visible = runs.filter((r) => r.text.trim().length > 0);
  if (visible.length === 0) return null;

  return (
    <div className="shrink-0 px-6 py-1.5 border-b border-[var(--hairline)] bg-[var(--canvas-soft)]">
      {visible.map((r) => (
        <div key={r.runId} className="flex items-start gap-2 text-xs">
          <span className="shrink-0 text-[var(--mute)]">Recap</span>
          <span className="text-[var(--body)] line-clamp-2">{r.text}</span>
        </div>
      ))}
    </div>
  );
}
