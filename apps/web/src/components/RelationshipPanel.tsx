"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AgentRow, RelationshipRow } from "@/lib/api";
import { api } from "@/lib/api";

interface RelationshipPanelProps {
  agentId: string;
  relationships: RelationshipRow[];
  agents: AgentRow[];
}

const REL_LABEL: Record<string, string> = {
  assigns_to: "delegates to",
  collaborates_with: "collaborates with",
};

export function RelationshipPanel({ agentId, relationships, agents }: RelationshipPanelProps) {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [toAgentId, setToAgentId] = useState("");
  const [relType, setRelType] = useState<"assigns_to" | "collaborates_with">("assigns_to");
  const [instruction, setInstruction] = useState("");

  const otherAgents = agents.filter((a) => a.id !== agentId && !a.archivedAt);

  async function handleAdd() {
    if (!toAgentId) {
      toast.error("Select an agent");
      return;
    }
    try {
      await api.createRelationship(agentId, {
        toAgentId,
        relType,
        instruction: instruction || undefined,
      });
      toast.success("Relationship created");
      setShowAdd(false);
      setToAgentId("");
      setInstruction("");
      qc.invalidateQueries({ queryKey: ["agent", agentId] });
    } catch {
      toast.error("Failed to create relationship");
    }
  }

  async function handleDelete(relId: string) {
    try {
      await api.deleteRelationship(agentId, relId);
      toast.success("Relationship deleted");
      qc.invalidateQueries({ queryKey: ["agent", agentId] });
    } catch {
      toast.error("Failed to delete relationship");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-(--mute)">
          {relationships.length} relationship{relationships.length !== 1 ? "s" : ""}
        </p>
        <Button size="sm" variant="outline" onClick={() => setShowAdd(!showAdd)}>
          <Plus size={14} /> Add
        </Button>
      </div>

      {showAdd && (
        <div className="border border-(--hairline) rounded-lg p-4 space-y-3">
          <Select value={toAgentId} onValueChange={(v) => setToAgentId(v ?? "")}>
            <SelectTrigger className="text-sm">
              <SelectValue placeholder="Select agent…" />
            </SelectTrigger>
            <SelectContent>
              {otherAgents.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={relType}
            onValueChange={(v) => setRelType(v as "assigns_to" | "collaborates_with")}
          >
            <SelectTrigger className="text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="assigns_to">delegates to</SelectItem>
              <SelectItem value="collaborates_with">collaborates with</SelectItem>
            </SelectContent>
          </Select>
          <Input
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="Delegate when: … (optional)"
            className="text-sm"
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={handleAdd}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowAdd(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {relationships.map((rel) => {
          const otherId = rel.fromAgent === agentId ? rel.toAgent : rel.fromAgent;
          const otherAgent = agents.find((a) => a.id === otherId);
          const direction = rel.fromAgent === agentId ? "→" : "←";
          return (
            <div
              key={rel.id}
              className="border border-(--hairline) rounded-lg p-3 flex items-center justify-between"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-(--ink-strong)">
                    {otherAgent?.name ?? otherId.slice(0, 8)}
                  </span>
                  <Badge variant="outline" className="text-xs">
                    {direction} {REL_LABEL[rel.relType] ?? rel.relType}
                  </Badge>
                  {rel.weight !== 1.0 && (
                    <span className="text-[10px] text-(--mute)">w={rel.weight.toFixed(1)}</span>
                  )}
                </div>
                {rel.instruction && (
                  <p className="text-xs text-(--mute) mt-1 truncate">{rel.instruction}</p>
                )}
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive shrink-0"
                onClick={() => handleDelete(rel.id)}
              >
                <Trash2 size={14} />
              </Button>
            </div>
          );
        })}
        {relationships.length === 0 && !showAdd && (
          <div className="text-center py-8">
            <p className="text-sm text-(--mute)">No relationships yet</p>
          </div>
        )}
      </div>
    </div>
  );
}
