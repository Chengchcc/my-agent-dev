"use client";

import type { WorkflowDefinition, WorkflowNode } from "@chengchenccc/workflow";
import { useMemo, useState } from "react";

type Def = WorkflowDefinition;

function updateNode(def: Def, nodeId: string, patch: Record<string, unknown>): Def {
  return {
    ...def,
    nodes: def.nodes.map((n) => (n.id === nodeId ? ({ ...n, ...patch } as WorkflowNode) : n)),
  };
}

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
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  if (!node) return null;
  return (
    <div className="space-y-3 p-4">
      <h3 className="text-sm font-semibold">Node: {nodeId}</h3>
      <label className="block text-xs">type</label>
      <input value={node.type} className="w-full rounded border p-1" readOnly />
      {node.type === "agent" && (
        <>
          <label className="block text-xs">agentId</label>
          <input
            value={node.agentId ?? ""}
            className="w-full rounded border p-1"
            onChange={(e) => setDraft({ ...draft, agentId: e.target.value })}
          />
          <label className="block text-xs">prompt</label>
          <textarea
            value={node.prompt ?? ""}
            className="w-full rounded border p-1"
            rows={4}
            onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
          />
        </>
      )}
      {node.type === "script" && (
        <>
          <label className="block text-xs">code</label>
          <textarea
            value={node.code ?? ""}
            className="w-full rounded border p-1 font-mono"
            rows={8}
            onChange={(e) => setDraft({ ...draft, code: e.target.value })}
          />
          <label className="block text-xs">timeoutMs</label>
          <input
            type="number"
            value={node.timeoutMs ?? ""}
            className="w-full rounded border p-1"
            onChange={(e) => setDraft({ ...draft, timeoutMs: Number(e.target.value) })}
          />
        </>
      )}
      {node.type === "end" && (
        <>
          <label className="block text-xs">status</label>
          <input
            value={node.status ?? ""}
            className="w-full rounded border p-1"
            onChange={(e) => setDraft({ ...draft, status: e.target.value })}
          />
        </>
      )}
      <button
        className="w-full rounded bg-slate-800 px-3 py-1 text-white"
        onClick={() => onChange(updateNode(definition, nodeId, draft))}
      >
        Apply
      </button>
    </div>
  );
}
