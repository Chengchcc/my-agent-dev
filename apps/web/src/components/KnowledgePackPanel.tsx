"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Checkbox } from "@/components/ui/checkbox";
import { useAgentDetail } from "@/features/agents/hooks";
import { type AgentRow, api } from "@/lib/api";
/** Agent-side knowledge switches (ADR 0022): the GLOBAL pack pool is the
 *  source; checking a pack writes its id into agent.yml (file-first);
 *  the bridge then links the pack + regenerates the knowledge index. */

export interface KnowledgePackRow {
  id: string;
  name: string;
  description: string;
  sourceKind: "builtin" | "git" | "zip";
  status: "pending" | "installing" | "ready" | "failed" | "syncing";
  error: string | null;
}

export function KnowledgePackPanel({ agentId }: { agentId: string }) {
  const qc = useQueryClient();
  const { data: agent } = useAgentDetail(agentId) as { data?: AgentRow };
  const { data: packsData } = useQuery({
    queryKey: ["knowledge-packs"],
    queryFn: () => api.listKnowledgePacks() as Promise<{ packs: KnowledgePackRow[] }>,
  });

  const packs = packsData?.packs ?? [];
  const assigned = new Set<string>(agent?.knowledgePacks ?? []);

  const toggle = async (packId: string, on: boolean) => {
    const next = new Set(assigned);
    if (on) next.add(packId);
    else next.delete(packId);
    await api.updateAgent(agentId, { knowledgePacks: [...next] });
    void qc.invalidateQueries({ queryKey: ["agent", agentId] });
    void qc.invalidateQueries({ queryKey: ["agents"] });
  };

  if (packs.length === 0) {
    return (
      <p className="text-sm text-(--mute)">
        No knowledge packs installed — add them on the Knowledge page.
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {packs.map((p) => (
        <li
          key={p.id}
          className="flex items-center justify-between gap-3 border border-(--hairline) rounded px-4 py-3"
        >
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">{p.name}</div>
            {p.description && <div className="text-xs text-(--mute) truncate">{p.description}</div>}
            {p.status !== "ready" && <div className="text-xs text-amber-500">{p.status}</div>}
          </div>
          <Checkbox
            checked={assigned.has(p.id)}
            disabled={p.status !== "ready"}
            onCheckedChange={(on) => void toggle(p.id, on === true)}
          />
        </li>
      ))}
    </ul>
  );
}
