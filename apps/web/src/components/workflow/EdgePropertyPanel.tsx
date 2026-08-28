"use client";

import type { JsonLogicRule, WorkflowDefinition } from "@chengchenccc/workflow";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

function updateEdgeWhen(
  def: WorkflowDefinition,
  edgeIndex: number,
  when: JsonLogicRule | undefined,
): WorkflowDefinition {
  return {
    ...def,
    edges: def.edges.map((e, i) => (i === edgeIndex ? { ...e, when } : e)),
  };
}

/** Edge inspector: the `when` JSONLogic condition, matched by DSL edge index. */
export function EdgePropertyPanel({
  edgeIndex,
  definition,
  onChange,
}: {
  edgeIndex: number;
  definition: WorkflowDefinition;
  onChange: (def: WorkflowDefinition) => void;
}) {
  const edge = definition.edges[edgeIndex];
  const [when, setWhen] = useState<string>(edge?.when ? JSON.stringify(edge.when, null, 2) : "");
  if (!edge) return null;
  return (
    <div className="space-y-3 p-4">
      <h3 className="text-sm font-semibold">
        Edge: {edge.from} → {edge.to}
      </h3>
      <div>
        <Label className="text-xs">when (JSONLogic)</Label>
        <Textarea
          className="mt-1 font-mono text-xs"
          rows={6}
          value={when}
          onChange={(e) => setWhen(e.target.value)}
          placeholder='{ "==": [ { "var": "a.output.x" }, "high" ] } (empty = unconditional)'
        />
      </div>
      <Button
        className="w-full"
        onClick={() => {
          try {
            onChange(
              updateEdgeWhen(definition, edgeIndex, when.trim() ? JSON.parse(when) : undefined),
            );
          } catch {
            alert("Invalid JSONLogic JSON");
          }
        }}
      >
        Apply
      </Button>
    </div>
  );
}
