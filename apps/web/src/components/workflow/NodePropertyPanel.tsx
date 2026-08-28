"use client";

import type { WorkflowDefinition, WorkflowNode } from "@chengchenccc/workflow";
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type Def = WorkflowDefinition;

function patchNode(def: Def, nodeId: string, patch: Record<string, unknown>): Def {
  return {
    ...def,
    nodes: def.nodes.map((n) => (n.id === nodeId ? ({ ...n, ...patch } as WorkflowNode) : n)),
  };
}

const TYPE_LABEL: Record<string, string> = {
  start: "Start",
  end: "End",
  agent: "Agent",
  script: "Script",
  human: "Human",
};

/** Node inspector — edits write straight back to the DSL (live). */
export function NodePropertyPanel({
  nodeId,
  definition,
  onChange,
}: {
  nodeId: string;
  definition: Def;
  onChange: (def: Def) => void;
}) {
  const node = useMemo(() => definition.nodes.find((n) => n.id === nodeId), [definition, nodeId]);
  if (!node) return null;

  const set = (patch: Record<string, unknown>) => onChange(patchNode(definition, nodeId, patch));

  return (
    <div className="flex h-full flex-col overflow-auto p-4 text-[#e5e7eb]">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="truncate font-mono text-sm font-semibold text-[#38bdf8]">{nodeId}</h3>
        <Badge variant="outline" className="shrink-0 border-[#1f2937] text-[10px] text-[#94a3b8]">
          {TYPE_LABEL[node.type] ?? node.type}
        </Badge>
      </div>

      {node.type === "agent" && (
        <>
          <div className="space-y-1">
            <Label className="text-xs text-[#94a3b8]">agentId</Label>
            <Input
              className="border-[#1f2937] bg-[#0b0e14] font-mono text-xs"
              value={node.agentId ?? ""}
              placeholder="或使用内联 model+prompt"
              onChange={(e) => set({ agentId: e.target.value })}
            />
          </div>
          <div className="mt-3 space-y-1">
            <Label className="text-xs text-[#94a3b8]">model</Label>
            <Input
              className="border-[#1f2937] bg-[#0b0e14] font-mono text-xs"
              value={node.model ?? ""}
              placeholder="deepseek/deepseek-v4-flash"
              onChange={(e) => set({ model: e.target.value })}
            />
          </div>
          <div className="mt-3 space-y-1">
            <Label className="text-xs text-[#94a3b8]">prompt</Label>
            <Textarea
              className="min-h-24 border-[#1f2937] bg-[#0b0e14] font-mono text-xs"
              value={node.prompt ?? ""}
              onChange={(e) => set({ prompt: e.target.value })}
            />
          </div>
        </>
      )}

      {node.type === "script" && (
        <>
          <div className="space-y-1">
            <Label className="text-xs text-[#94a3b8]">code</Label>
            <Textarea
              className="min-h-32 border-[#1f2937] bg-[#0b0e14] font-mono text-xs"
              value={node.code ?? ""}
              onChange={(e) => set({ code: e.target.value })}
            />
          </div>
          <div className="mt-3 space-y-1">
            <Label className="text-xs text-[#94a3b8]">timeoutMs</Label>
            <Input
              type="number"
              className="border-[#1f2937] bg-[#0b0e14] font-mono text-xs"
              value={node.timeoutMs ?? ""}
              onChange={(e) =>
                set({ timeoutMs: e.target.value === "" ? undefined : Number(e.target.value) })
              }
            />
          </div>
        </>
      )}

      {node.type === "human" && (
        <div className="space-y-1">
          <Label className="text-xs text-[#94a3b8]">question</Label>
          <Textarea
            className="min-h-24 border-[#1f2937] bg-[#0b0e14] font-mono text-xs"
            value={node.question ?? ""}
            onChange={(e) => set({ question: e.target.value })}
          />
        </div>
      )}

      {node.type === "end" && (
        <div className="space-y-1">
          <Label className="text-xs text-[#94a3b8]">status</Label>
          <Input
            className="border-[#1f2937] bg-[#0b0e14] font-mono text-xs"
            value={node.status ?? ""}
            onChange={(e) => set({ status: e.target.value })}
          />
        </div>
      )}

      {node.retry !== undefined && (
        <div className="mt-3 space-y-1">
          <Label className="text-xs text-[#94a3b8]">retry</Label>
          <Input
            type="number"
            className="border-[#1f2937] bg-[#0b0e14] font-mono text-xs"
            value={node.retry}
            onChange={(e) => set({ retry: Number(e.target.value) })}
          />
        </div>
      )}
    </div>
  );
}
