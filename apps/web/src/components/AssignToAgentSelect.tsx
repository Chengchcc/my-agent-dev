"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AgentRow } from "@/lib/api";

/** Quick assign control for global resource rows: pick an agent to bind this
 *  resource to, without navigating to the agent detail tab. Full-width select
 *  that resets after each assignment. */
export function AssignToAgentSelect({
  agents,
  assigned,
  onAssign,
}: {
  agents: AgentRow[];
  assigned: (agentId: string) => boolean;
  onAssign: (agentId: string) => void;
}) {
  const unassigned = agents.filter((a) => !assigned(a.id));

  return (
    <Select
      value=""
      onValueChange={(v) => {
        if (v) onAssign(v);
      }}
      disabled={unassigned.length === 0}
    >
      <SelectTrigger size="sm" className="w-full">
        <SelectValue placeholder={unassigned.length === 0 ? "All assigned" : "Assign…"} />
      </SelectTrigger>
      <SelectContent>
        {unassigned.map((a) => (
          <SelectItem key={a.id} value={a.id}>
            {a.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
