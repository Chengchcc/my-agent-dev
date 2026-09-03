"use client";

import { useState } from "react";
import type { AgentRow } from "@/lib/api";

/** Quick assign control for global resource rows: pick an agent to bind this
 *  resource to, without navigating to the agent detail tab. */
export function AssignToAgentSelect({
  agents,
  assigned,
  onAssign,
}: {
  agents: AgentRow[];
  assigned: (agentId: string) => boolean;
  onAssign: (agentId: string) => void;
}) {
  const [value, setValue] = useState("");
  const unassigned = agents.filter((a) => !assigned(a.id));

  return (
    <select
      value={value}
      onChange={(e) => {
        if (!e.target.value) return;
        onAssign(e.target.value);
        setValue("");
      }}
      className="h-7 rounded border border-(--hairline) bg-transparent px-1.5 text-xs text-(--text-body)"
      disabled={unassigned.length === 0}
      aria-label="Assign to agent"
    >
      <option value="">{unassigned.length === 0 ? "All assigned" : "Assign…"}</option>
      {unassigned.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </select>
  );
}
