"use client";

import { Bot, Download, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AgentRow } from "@/lib/api";

/** Description card: 72px avatar + description + "AI update" (postponed)
 *  and "Export agent.yml" (no exporter yet) — both disabled until the
 *  backend supports them (§6.4). */
export function AgentDescriptionCard({ agent }: { agent: AgentRow }) {
  return (
    <section className="flex items-start gap-4 rounded-(--radius-card) border border-(--hairline) bg-(--panel) p-4">
      <span
        aria-hidden
        className="flex shrink-0 items-center justify-center rounded-[12px] bg-(--panel2) text-(--mute)"
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
      <div className="flex shrink-0 flex-col items-stretch gap-2">
        <Button variant="ghost" size="sm" disabled title="AI description update coming soon">
          <Sparkles className="size-3.5" /> AI update
        </Button>
        <Button variant="outline" size="sm" disabled title="Export not available yet">
          <Download className="size-3.5" /> Export agent.yml
        </Button>
      </div>
    </section>
  );
}
