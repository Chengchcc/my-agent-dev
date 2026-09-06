"use client";

import type { ReactNode } from "react";

/** Shared full-viewport editor shell for the agent pages (create + edit):
 *  a fixed header on top, then a two-pane body — a scrollable left column
 *  (the form) and a full-height right chat column with the input pinned at
 *  the bottom. Both /team/new/edit and /team/[agentId]/edit render this so
 *  the layout stays consistent and the chat input never scrolls off-screen.
 */
export function AgentEditorLayout({
  header,
  left,
  chat,
}: {
  header: ReactNode;
  left: ReactNode;
  chat: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      {header}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto border-(--hairline) p-4 md:border-r">
          {left}
        </div>
        <div className="flex w-[320px] shrink-0 flex-col border-l border-(--hairline)">{chat}</div>
      </div>
    </div>
  );
}
