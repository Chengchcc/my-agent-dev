"use client";

import { toEditorGraph, type WorkflowDefinition, type WorkflowNode } from "@chengchenccc/workflow";
import { useMemo, useState } from "react";
import { ChatPanel } from "./ChatPanel";
import { DslEditorPanel } from "./DslEditorPanel";
import { EdgePropertyPanel } from "./EdgePropertyPanel";
import { NodePalette } from "./NodePalette";
import { NodePropertyPanel } from "./NodePropertyPanel";
import { WorkflowCanvas } from "./WorkflowCanvas";

type Tab = "attrs" | "dsl" | "chat";

function makeNodeId(base: string): string {
  return `${base}-${Math.random().toString(36).slice(2, 7)}`;
}

function addNode(def: WorkflowDefinition, node: WorkflowNode) {
  return { ...def, nodes: [...def.nodes, node] };
}
function addEdge(def: WorkflowDefinition, from: string, to: string) {
  if (def.edges.some((e) => e.from === from && e.to === to)) return def;
  return { ...def, edges: [...def.edges, { from, to }] };
}
function deleteNode(def: WorkflowDefinition, id: string) {
  return {
    ...def,
    nodes: def.nodes.filter((n) => n.id !== id),
    edges: def.edges.filter((e) => e.from !== id && e.to !== id),
  };
}

export function AgenticWorkflowEditor({
  workflowId,
  initial,
}: {
  workflowId: string;
  initial: WorkflowDefinition | null;
}) {
  const [definition, setDefinition] = useState<WorkflowDefinition | null>(initial);
  const [tab, setTab] = useState<Tab>("attrs");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeEdgeIndex, setActiveEdgeIndex] = useState<number | null>(null);
  const graph = useMemo(() => (definition ? toEditorGraph(definition) : null), [definition]);

  return (
    <div className="flex h-full">
      <div className="flex flex-1 flex-col border-r">
        {definition && (
          <NodePalette
            onAdd={(node) =>
              setDefinition(addNode(definition, { ...node, id: makeNodeId(node.type) }))
            }
          />
        )}
        {graph && definition ? (
          <WorkflowCanvas
            graph={graph}
            interactive
            onSelect={(id) => {
              setActiveId(id);
              setActiveEdgeIndex(null);
              setTab("attrs");
            }}
            onConnect={(from, to) => setDefinition(addEdge(definition, from, to))}
            onNodeDelete={(id) => setDefinition(deleteNode(definition, id))}
            onEdgeSelect={(i) => {
              setActiveEdgeIndex(i);
              setActiveId(null);
              setTab("attrs");
            }}
          />
        ) : (
          <div className="p-8 text-muted-foreground">No workflow loaded.</div>
        )}
      </div>
      <div className="w-80 border-l">
        <div className="flex border-b">
          {(
            [
              ["attrs", "属性"],
              ["dsl", "DSL"],
              ["chat", "Chat"],
            ] as Array<[Tab, string]>
          ).map(([k, label]) => (
            <button
              key={k}
              className={`flex-1 py-2 text-xs ${tab === k ? "border-b-2 border-amber-500 font-semibold" : "text-muted-foreground"}`}
              onClick={() => setTab(k)}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === "attrs" && activeEdgeIndex !== null && definition ? (
          <EdgePropertyPanel
            edgeIndex={activeEdgeIndex}
            definition={definition}
            onChange={setDefinition}
          />
        ) : tab === "attrs" && activeId && definition ? (
          <NodePropertyPanel nodeId={activeId} definition={definition} onChange={setDefinition} />
        ) : tab === "dsl" ? (
          <DslEditorPanel
            workflowId={workflowId}
            definition={definition}
            onChange={setDefinition}
          />
        ) : (
          <ChatPanel />
        )}
      </div>
    </div>
  );
}
