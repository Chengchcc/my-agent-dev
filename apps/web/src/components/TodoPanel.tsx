"use client";

import type { SenderRef } from "@/lib/conversation-reducer";
import type { TodoItem } from "@/lib/transient-reducer";

/** Renders per-run task lists (Run-local transient todos) pinned above the
 *  conversation timeline. Empty → renders nothing. One section per active
 *  run so multi-agent streams never share a list. */
export function TodoPanel({
  runs,
}: {
  runs: Array<{ runId: string; agent: SenderRef; items: readonly TodoItem[] }>;
}) {
  const visible = runs.filter((r) => r.items.length > 0);
  if (visible.length === 0) return null;

  return (
    <div className="shrink-0 px-6 py-2 border-b border-[var(--hairline)] bg-[var(--canvas-soft)]">
      {visible.map((r) => {
        const done = r.items.filter((t) => t.status === "done").length;
        return (
          <div key={r.runId} className={visible.length > 1 ? "mb-2 last:mb-0" : ""}>
            {visible.length > 1 && (
              <p className="text-[10px] text-[var(--mute)] mb-0.5">
                {r.agent.displayName ?? r.agent.memberId}
              </p>
            )}
            <p className="text-[10px] tracking-[0.1em] uppercase text-[var(--mute)] font-semibold mb-1">
              Plan &middot; {done}/{r.items.length}
            </p>
            <ul className="space-y-0.5">
              {r.items.map((t) => (
                <li key={t.id} className="flex items-center gap-2 text-xs">
                  <span className="shrink-0 w-4 text-center">
                    {t.status === "done" ? "☑" : t.status === "in_progress" ? "▸" : "☐"}
                  </span>
                  <span
                    className={
                      t.status === "done"
                        ? "line-through text-[var(--mute)]"
                        : t.status === "in_progress"
                          ? "text-[var(--primary)]"
                          : t.status === "cancelled"
                            ? "line-through opacity-50 text-[var(--mute)]"
                            : "text-[var(--body)]"
                    }
                  >
                    {t.text}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
