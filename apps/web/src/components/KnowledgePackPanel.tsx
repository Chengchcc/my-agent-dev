"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Library } from "lucide-react";
import { toast } from "sonner";
import { ListRowCard, statusBadge } from "@/components/ui/polish";
import { Switch } from "@/components/ui/switch";
import { useAgentDetail } from "@/features/agents/hooks";
import { agentKeys } from "@/features/agents/query-keys";
import { useKnowledgePacks } from "@/features/knowledge/hooks";
import { type AgentRow, api } from "@/lib/api";

/** Agent-side knowledge switches (ADR 0022): the GLOBAL pack pool is the
 *  source; checking a pack writes its id into agent.yml (file-first);
 *  the bridge then links the pack + regenerates the knowledge index. */

export function KnowledgePackPanel({ agentId }: { agentId: string }) {
  const qc = useQueryClient();
  const { data: agent } = useAgentDetail(agentId) as { data?: AgentRow };
  const { data: packsData } = useKnowledgePacks();

  const packs = packsData?.packs ?? [];
  const assigned = new Set<string>(agent?.knowledgePacks ?? []);

  const toggle = async (packId: string, on: boolean) => {
    const next = new Set(assigned);
    if (on) next.add(packId);
    else next.delete(packId);
    try {
      await api.updateAgent(agentId, { knowledgePacks: [...next] });
    } catch (err) {
      toast.error("Failed to update knowledge packs", {
        description: err instanceof Error ? err.message : undefined,
      });
    }
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
      {packs.map((p) => {
        const linked = assigned.has(p.id);
        return (
          <ListRowCard
            key={p.id}
            icon={<Library className="size-4 text-(--mute)" />}
            title={p.name}
            desc={p.error ? `${p.description} — ${p.error}` : p.description}
            // Ready is a GLOBAL install state; a green "ok" badge alone made
            // users read it as "linked". Ready-but-unassigned shows a neutral
            // "installed (not assigned)" badge instead of the green one.
            badges={[
              p.status === "ready" && !linked ? "installed (not assigned)" : statusBadge(p.status),
            ]}
            meta={p.status === "ready" && !linked ? ["available (not assigned)"] : undefined}
            actions={
              <Switch
                checked={linked}
                disabled={p.status !== "ready"}
                onCheckedChange={(on) => void toggle(p.id, on === true)}
              />
            }
          />
        );
      })}
    </div>
  );
}
