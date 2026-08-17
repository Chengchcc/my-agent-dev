"use client";

import { Bot } from "lucide-react";
import Link from "next/link";
import { AgentForm } from "@/components/AgentForm";
import { EmptyState } from "@/components/ui/empty-state";
import { ListToolbar, SectionKicker } from "@/components/ui/polish";
import type { AgentRow } from "@/lib/api";

/** Column 2 of the master-detail split: 280px agent rail (search + list). */
export function AgentListColumn({
  agents,
  selectedId,
  searchValue,
  onSearch,
}: {
  agents: AgentRow[];
  selectedId?: string;
  searchValue: string;
  onSearch: (v: string) => void;
}) {
  return (
    <aside className="flex w-[280px] shrink-0 flex-col border-r border-(--hairline)">
      <div className="flex items-center justify-between gap-2 border-b border-(--hairline) px-4 py-3">
        <span className="text-(--text-emph) font-semibold text-(--ink)">My Agents</span>
        <AgentForm />
      </div>
      <div className="px-3 py-2">
        <ListToolbar searchValue={searchValue} onSearch={onSearch} placeholder="Search agents…" />
      </div>
      <nav aria-label="Agents" className="flex-1 overflow-y-auto px-3 pb-4">
        <SectionKicker>All</SectionKicker>
        {agents.length === 0 ? (
          <EmptyState
            icon={Bot}
            title="No agents yet"
            description="Create your first agent to get started."
          />
        ) : (
          <ul className="space-y-1">
            {agents.map((a) => {
              const active = a.id === selectedId;
              return (
                <li key={a.id}>
                  <Link
                    href={`/team/agents/${a.id}`}
                    aria-current={active ? "page" : undefined}
                    className={`flex items-center gap-2 rounded-lg px-2 py-2 ${
                      active ? "bg-(--panel2)" : "hover:bg-(--panel)"
                    }`}
                    style={{ minHeight: 56 }}
                  >
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-(--panel2) text-(--mute)">
                      <Bot className="size-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-(--text-emph) font-medium text-(--ink)">
                        {a.name}
                      </span>
                      <span className="block truncate text-(--text-cap) text-(--mute)">
                        {a.modelName}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </nav>
    </aside>
  );
}
