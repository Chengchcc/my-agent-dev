"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Library } from "lucide-react";
import { ListRowCard } from "@/components/ui/polish";
import { Switch } from "@/components/ui/switch";
import { useAgentDetail } from "@/features/agents/hooks";
import { agentKeys } from "@/features/agents/query-keys";
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
    void qc.invalidateQueries({ queryKey: agentKeys.detail(agentId) });
    void qc.invalidateQueries({ queryKey: agentKeys.lists() });
  };

  if (packs.length === 0) {
    return (
      <p className="text-sm text-(--mute)">
        No knowledge packs installed — add them on the Knowledge page.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {packs.map((p) => (
        <ListRowCard
          key={p.id}
          icon={<Library className="size-4 text-(--mute)" />}
          title={p.name}
          desc={p.error ? `${p.description} — ${p.error}` : p.description}
          badges={[p.status]}
          status={p.status === "ready" ? "ok" : p.status === "failed" ? "err" : undefined}
          actions={
            <Switch
              checked={assigned.has(p.id)}
              disabled={p.status !== "ready"}
              onCheckedChange={(on) => void toggle(p.id, on === true)}
            />
          }
        />
      ))}
    </div>
  );
}
