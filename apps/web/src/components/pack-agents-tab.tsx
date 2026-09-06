"use client";

import { ExternalLink, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { AssignToAgentSelect } from "@/components/AssignToAgentSelect";
import { Text } from "@/components/ui/text";
import type { AgentRow } from "@/lib/api";

/** Actionable "Agents" tab shared by the skill / knowledge / MCP detail
 *  sheets: assign from the unassigned pool, click an agent to open its
 *  detail page, and remove it from this resource. Replaces the old
 *  read-only name list that could not be operated on. */
export function PackAgentsTab({
  agents,
  usedBy,
  isAssigned,
  onAssign,
  onRemove,
}: {
  agents: AgentRow[];
  usedBy: AgentRow[];
  isAssigned: (agentId: string) => boolean;
  onAssign: (agentId: string) => void;
  onRemove: (agentId: string) => void;
}) {
  const router = useRouter();

  return (
    <div className="space-y-3">
      <AssignToAgentSelect agents={agents} assigned={isAssigned} onAssign={onAssign} />
      {usedBy.length === 0 ? (
        <Text as="p" className="text-sm text-(--mute)">
          Not assigned to any agent yet.
        </Text>
      ) : (
        usedBy.map((agent) => (
          <div
            key={agent.id}
            className="flex items-center justify-between gap-2 rounded-md border border-(--hairline) px-3 py-2"
          >
            <button
              type="button"
              onClick={() => router.push(`/team/${agent.id}`)}
              className="flex min-w-0 items-center gap-1.5 text-left text-sm text-(--ink) hover:text-(--primary)"
            >
              <span className="truncate">{agent.name}</span>
              <ExternalLink className="size-3 shrink-0 text-(--faint)" />
            </button>
            <div className="flex shrink-0 items-center gap-2">
              <span className="rounded bg-(--ok)/12 px-1.5 py-0.5 text-xs text-(--ok)">Active</span>
              <button
                type="button"
                aria-label={`Remove ${agent.name}`}
                onClick={() => onRemove(agent.id)}
                className="rounded p-1 text-(--mute) hover:bg-(--canvas-soft) hover:text-(--err)"
              >
                <X className="size-3.5" />
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
