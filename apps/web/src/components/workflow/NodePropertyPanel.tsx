"use client";

import type { WorkflowDefinition, WorkflowNode } from "@chengchenccc/workflow";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";

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
  const [agents, setAgents] = useState<Array<{ id: string; name?: string }>>([]);
  useEffect(() => {
    api
      .listAgents()
      .then((rows) =>
        setAgents((rows ?? []).map((a) => ({ id: a.id, name: (a as { name?: string }).name }))),
      )
      .catch(() => setAgents([]));
  }, []);
  if (!node) return null;

  const set = (patch: Record<string, unknown>) => onChange(patchNode(definition, nodeId, patch));

  return (
    <div className="flex h-full flex-col overflow-auto p-4 text-[var(--ink)]">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="truncate font-mono text-sm font-semibold text-[var(--info)]">{nodeId}</h3>
        <Badge
          variant="outline"
          className="shrink-0 border-[var(--hairline)] text-[10px] text-[var(--mute)]"
        >
          {TYPE_LABEL[node.type] ?? node.type}
        </Badge>
      </div>

      {node.type === "agent" && (
        <>
          <div className="space-y-1">
            <Label className="text-xs text-[var(--mute)]">agent（从系统选择）</Label>
            <Select value={node.agentId ?? ""} onValueChange={(v) => set({ agentId: v })}>
              <SelectTrigger className="h-8 w-full border-[var(--hairline)] bg-[var(--canvas)] font-mono text-xs">
                <SelectValue placeholder="选择 agent，或留空内联 model+prompt" />
              </SelectTrigger>
              <SelectContent>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name ? `${a.name} (${a.id})` : a.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="mt-3 space-y-1">
            <Label className="text-xs text-[var(--mute)]">model</Label>
            <Input
              className="border-[var(--hairline)] bg-[var(--canvas)] font-mono text-xs"
              value={node.model ?? ""}
              placeholder="deepseek/deepseek-v4-flash"
              onChange={(e) => set({ model: e.target.value })}
            />
          </div>
          <div className="mt-3 space-y-1">
            <Label className="text-xs text-[var(--mute)]">prompt</Label>
            <Textarea
              className="min-h-24 border-[var(--hairline)] bg-[var(--canvas)] font-mono text-xs"
              value={node.prompt ?? ""}
              onChange={(e) => set({ prompt: e.target.value })}
            />
          </div>
        </>
      )}

      {node.type === "script" && (
        <>
          <div className="space-y-1">
            <Label className="text-xs text-[var(--mute)]">code</Label>
            <Textarea
              className="min-h-32 border-[var(--hairline)] bg-[var(--canvas)] font-mono text-xs"
              value={node.code ?? ""}
              onChange={(e) => set({ code: e.target.value })}
            />
          </div>
          <div className="mt-3 space-y-1">
            <Label className="text-xs text-[var(--mute)]">timeoutMs</Label>
            <Input
              type="number"
              className="border-[var(--hairline)] bg-[var(--canvas)] font-mono text-xs"
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
          <Label className="text-xs text-[var(--mute)]">question</Label>
          <Textarea
            className="min-h-24 border-[var(--hairline)] bg-[var(--canvas)] font-mono text-xs"
            value={node.question ?? ""}
            onChange={(e) => set({ question: e.target.value })}
          />
        </div>
      )}

      {node.type === "end" && (
        <div className="space-y-1">
          <Label className="text-xs text-[var(--mute)]">status</Label>
          <Input
            className="border-[var(--hairline)] bg-[var(--canvas)] font-mono text-xs"
            value={node.status ?? ""}
            onChange={(e) => set({ status: e.target.value })}
          />
        </div>
      )}

      {node.retry !== undefined && (
        <div className="mt-3 space-y-1">
          <Label className="text-xs text-[var(--mute)]">retry</Label>
          <Input
            type="number"
            className="border-[var(--hairline)] bg-[var(--canvas)] font-mono text-xs"
            value={node.retry}
            onChange={(e) => set({ retry: Number(e.target.value) })}
          />
        </div>
      )}
    </div>
  );
}
