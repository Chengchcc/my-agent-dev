"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Server } from "lucide-react";
import { toast } from "sonner";
import { ListRowCard } from "@/components/ui/polish";
import { Switch } from "@/components/ui/switch";
import { useAgentDetail } from "@/features/agents/hooks";
import { agentKeys } from "@/features/agents/query-keys";
import { useMcpCatalog } from "@/features/mcp/hooks";
import { type AgentRow, api } from "@/lib/api";

/** Agent-side MCP switches (ADR 0022): the GLOBAL catalog is the pool;
 *  this panel toggles the agent's subset, persisted to agent.yml via the
 *  agent update API (file-first). Server CRUD lives at /team/mcp. */

export interface AgentMcpSwitch {
  serverId: string;
  enabled: boolean;
}

function rowStatus(status?: string): "ok" | "err" | undefined {
  if (status === "connected") return "ok";
  if (status === "failed") return "err";
  return undefined;
}

export function McpServerPanel({ agentId }: { agentId: string }) {
  const qc = useQueryClient();
  const { data: agent } = useAgentDetail(agentId) as { data?: AgentRow };
  const { data: catalogData } = useMcpCatalog();

  const servers = catalogData?.mcpServers ?? [];
  const switches = new Map(
    (agent?.mcpServers ?? []).map((s: AgentMcpSwitch) => [s.serverId, s.enabled]),
  );

  const toggle = async (serverId: string, enabled: boolean) => {
    const next = (agent?.mcpServers ?? []).filter((s: AgentMcpSwitch) => s.serverId !== serverId);
    next.push({ serverId, enabled });
    try {
      await api.updateAgent(agentId, { mcpServers: next });
    } catch (err) {
      toast.error("Failed to update MCP servers", {
        description: err instanceof Error ? err.message : undefined,
      });
    }
    void qc.invalidateQueries({ queryKey: agentKeys.detail(agentId) });
    void qc.invalidateQueries({ queryKey: agentKeys.lists() });
  };

  if (servers.length === 0) {
    return (
      <p className="text-sm text-(--mute)">
        No MCP servers in the catalog yet — add them on the MCP page.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {servers.map((s) => (
        <ListRowCard
          key={s.serverId}
          icon={<Server className="size-4 text-(--mute)" />}
          title={s.name}
          tag={{ label: s.transport }}
          desc={s.transport === "sse" ? (s.url ?? undefined) : (s.command ?? undefined)}
          meta={(switches.get(s.serverId) ?? false) ? undefined : ["available (not assigned)"]}
          status={rowStatus(s.status)}
          actions={
            <Switch
              checked={switches.get(s.serverId) ?? false}
              onCheckedChange={(on) => void toggle(s.serverId, on)}
            />
          }
        />
      ))}
    </div>
  );
}
