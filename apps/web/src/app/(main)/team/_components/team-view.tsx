"use client";

import { useMemo, useState } from "react";
import { useAgentList } from "@/features/agents/hooks";
import { AgentDetail } from "./agent-detail";
import { AgentListColumn } from "./agent-list-column";

/** Master-detail split for /team/[agentId]: 280px agent rail + detail
 *  column. The rail switches agents without leaving the page (md+; on
 *  small screens the overview grid is the switcher). */
export function TeamView({ selectedId }: { selectedId: string }) {
  const { data: agents } = useAgentList();
  const [query, setQuery] = useState("");

  const active = useMemo(() => (agents ?? []).filter((a) => !a.archivedAt), [agents]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return active;
    return active.filter((a) => a.name.toLowerCase().includes(q));
  }, [active, query]);

  return (
    <div className="flex h-full min-h-0">
      <div className="hidden size-full md:flex md:w-auto">
        <AgentListColumn
          agents={filtered}
          selectedId={selectedId}
          searchValue={query}
          onSearch={setQuery}
        />
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <AgentDetail agentId={selectedId} />
      </div>
    </div>
  );
}
