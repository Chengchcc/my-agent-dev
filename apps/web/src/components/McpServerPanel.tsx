"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { useAgentDetail } from "@/features/agents/hooks";
import { type AgentRow, api } from "@/lib/api";

/** Agent-side MCP switches (ADR 0022): the GLOBAL catalog is the pool;
 *  this panel toggles the agent's subset, persisted to agent.yml via the
 *  agent update API (file-first). Server CRUD lives at /team/mcp. */

export interface McpCatalogRow {
  serverId: string;
  name: string;
  transport: "stdio" | "sse";
  command: string | null;
  url: string | null;
  status?: "pending" | "connected" | "failed";
  toolsCount?: number;
}

export interface AgentMcpSwitch {
  serverId: string;
  enabled: boolean;
}

function statusVariant(status?: string): "default" | "destructive" | "secondary" | "outline" {
  if (status === "connected") return "default";
  if (status === "failed") return "destructive";
  if (status === "pending") return "secondary";
  return "outline";
}

export function McpServerPanel({ agentId }: { agentId: string }) {
  const qc = useQueryClient();
  const { data: agent } = useAgentDetail(agentId) as { data?: AgentRow };
  const { data: catalogData } = useQuery({
    queryKey: ["mcp-catalog"],
    queryFn: () => api.listMcpServers() as Promise<{ mcpServers: McpCatalogRow[] }>,
  });

  const servers = catalogData?.mcpServers ?? [];
  const switches = new Map(
    (agent?.mcpServers ?? []).map((s: AgentMcpSwitch) => [s.serverId, s.enabled]),
  );

  const toggle = async (serverId: string, enabled: boolean) => {
    const next = (agent?.mcpServers ?? []).filter((s: AgentMcpSwitch) => s.serverId !== serverId);
    next.push({ serverId, enabled });
    await api.updateAgent(agentId, { mcpServers: next });
    void qc.invalidateQueries({ queryKey: ["agent", agentId] });
    void qc.invalidateQueries({ queryKey: ["agents"] });
  };

  if (servers.length === 0) {
    return (
      <p className="text-sm text-(--mute)">
        No MCP servers in the catalog yet — add them on the MCP page.
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {servers.map((s) => (
        <li
          key={s.serverId}
          className="flex items-center justify-between gap-3 border border-(--hairline) rounded px-4 py-3"
        >
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">{s.name}</div>
            <div className="text-xs text-(--mute) truncate">
              {s.transport === "sse" ? s.url : s.command}
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <Badge variant={statusVariant(s.status)} className="text-xs">
              {s.status ?? "unknown"}
            </Badge>
            <Switch
              checked={switches.get(s.serverId) ?? false}
              onCheckedChange={(on) => void toggle(s.serverId, on)}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
