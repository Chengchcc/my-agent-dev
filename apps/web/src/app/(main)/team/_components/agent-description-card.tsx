"use client";

import { Bot } from "lucide-react";
import type { AgentRow } from "@/lib/api";

/** Description card: 72px avatar + model line. The postponed AI-update /
 *  export actions were removed — re-add a button when its backend lands. */
export function AgentDescriptionCard({ agent }: { agent: AgentRow }) {
  return (
    <section className="flex items-start gap-4 rounded-(--radius-card) border border-(--hairline) bg-(--panel) p-4">
      <span
        aria-hidden
        className="flex shrink-0 items-center justify-center rounded-xl bg-(--panel2) text-(--mute)"
        style={{ width: 72, height: 72 }}
      >
        <Bot className="size-8" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-(--text-body) text-(--ink)">{agent.name}</p>
        <p className="mt-1 text-(--text-body) text-(--mute)">
          {agent.modelProvider}/{agent.modelName} · {agent.backendKind}
        </p>
        <p className="mt-2 text-(--text-cap) text-(--faint)">
          A2A uses this description to select the agent.
        </p>
      </div>
    </section>
  );
}
