"use client";

import type { JsonLogicRule, WorkflowDefinition } from "@chengchenccc/workflow";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

function updateEdge(
  def: WorkflowDefinition,
  edgeIndex: number,
  patch: Record<string, unknown>,
): WorkflowDefinition {
  return {
    ...def,
    edges: def.edges.map((e, i) => (i === edgeIndex ? ({ ...e, ...patch } as typeof e) : e)),
  };
}

/** Edge inspector: from/to reconnection + `when` JSONLogic condition. */
export function EdgePropertyPanel({
  edgeIndex,
  definition,
  onChange,
  onDelete,
}: {
  edgeIndex: number;
  definition: WorkflowDefinition;
  onChange: (def: WorkflowDefinition) => void;
  onDelete?: (def: WorkflowDefinition) => void;
}) {
  const edge = useMemo(() => definition.edges[edgeIndex], [definition, edgeIndex]);
  const [when, setWhen] = useState<string>(edge?.when ? JSON.stringify(edge.when, null, 2) : "");
  if (!edge) return null;

  const nodeOptions = definition.nodes
    .filter((n) => n.type !== "start")
    .map((n) => ({ value: n.id, label: n.id }));

  return (
    <div className="flex h-full flex-col overflow-auto p-4 text-(--ink)">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="truncate font-mono text-sm font-semibold text-(--info)">
          {edge.from} → {edge.to}
        </h3>
        <button
          onClick={() => onDelete?.(deleteEdge(definition, edgeIndex))}
          className="text-xs text-(--err) hover:underline"
        >
          删除此边
        </button>
      </div>

      <div className="space-y-1">
        <Label className="text-xs text-(--mute)">from</Label>
        <Select
          value={edge.from}
          onValueChange={(v) => onChange(updateEdge(definition, edgeIndex, { from: v }))}
        >
          <SelectTrigger className="h-8 border-(--hairline) bg-(--canvas) font-mono text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {definition.nodes.map((n) => (
              <SelectItem key={n.id} value={n.id}>
                {n.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="mt-3 space-y-1">
        <Label className="text-xs text-(--mute)">to</Label>
        <Select
          value={edge.to}
          onValueChange={(v) => onChange(updateEdge(definition, edgeIndex, { to: v }))}
        >
          <SelectTrigger className="h-8 border-(--hairline) bg-(--canvas) font-mono text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {nodeOptions.map((n) => (
              <SelectItem key={n.value} value={n.value}>
                {n.value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="mt-3 flex flex-1 flex-col space-y-1">
        <Label className="text-xs text-(--mute)">when（JSONLogic，空 = 无条件）</Label>
        <Textarea
          className="min-h-28 flex-1 border-(--hairline) bg-(--canvas) font-mono text-xs"
          value={when}
          onChange={(e) => setWhen(e.target.value)}
          placeholder='{ "==": [ { "var": "a.output.x" }, "high" ] }'
        />
        <Button
          className="mt-1 w-full"
          onClick={() => {
            try {
              const parsed: JsonLogicRule | undefined = when.trim()
                ? (JSON.parse(when) as JsonLogicRule)
                : undefined;
              onChange(updateEdge(definition, edgeIndex, { when: parsed }));
            } catch {
              alert("Invalid JSONLogic JSON");
            }
          }}
        >
          Apply condition
        </Button>
      </div>
    </div>
  );
}

function deleteEdge(def: WorkflowDefinition, edgeIndex: number): WorkflowDefinition {
  return { ...def, edges: def.edges.filter((_, i) => i !== edgeIndex) };
}
