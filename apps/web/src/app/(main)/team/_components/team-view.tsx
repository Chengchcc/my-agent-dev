"use client";

import { Bot } from "lucide-react";
import { useMemo, useState } from "react";
import { OnboardingChecklist } from "@/components/OnboardingChecklist";
import { Page, PageHeader } from "@/components/page";
import { EmptyState } from "@/components/ui/empty-state";
import { useAgentList } from "@/features/agents/hooks";
import { AgentDetail } from "./agent-detail";
import { AgentListColumn } from "./agent-list-column";
/** Master-detail split for /team and /team/[agentId]: 280px agent rail +
 *  detail column. `/team` shows the first agent; the deep-link route
 *  `/team/[agentId]` pins that agent. */
export function TeamView({ selectedId }: { selectedId?: string }) {
  const { data: agents, isLoading } = useAgentList();
  const [query, setQuery] = useState("");

  const active = useMemo(() => (agents ?? []).filter((a) => !a.archivedAt), [agents]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return active;
    return active.filter((a) => a.name.toLowerCase().includes(q));
  }, [active, query]);

  const currentId = selectedId ?? filtered[0]?.id;

  return (
    <div className="flex h-full min-h-0">
      {/* <md: list shows only when nothing is selected; detail takes over
       *  once an agent is picked (the hidden list is reachable again via
       *  browser back). md+: master-detail side by side. */}
      <div className={`${currentId ? "hidden" : "flex"} size-full md:flex md:w-auto`}>
        <AgentListColumn
          agents={filtered}
          selectedId={currentId}
          searchValue={query}
          onSearch={setQuery}
        />
      </div>
      <div className={`${currentId ? "flex" : "hidden"} min-w-0 flex-1 overflow-y-auto md:flex`}>
        {currentId ? (
          <AgentDetail agentId={currentId} />
        ) : (
          <Page>
            <PageHeader breadcrumb={[{ label: "Team" }, { label: "Agents" }]} title="Agents" />
            <div className="px-4 sm:px-6 lg:px-8 py-6">
              {isLoading ? (
                <div className="h-40 animate-pulse rounded-lg bg-(--panel2)" />
              ) : (
                <>
                  <EmptyState
                    icon={Bot}
                    title="No agents yet"
                    description="Create your first agent to get started."
                  />
                  <div className="mt-4">
                    <OnboardingChecklist />
                  </div>
                </>
              )}
            </div>
          </Page>
        )}
      </div>
    </div>
  );
}
