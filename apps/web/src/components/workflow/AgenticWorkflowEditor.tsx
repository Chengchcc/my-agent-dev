"use client";

import { toEditorGraph, type WorkflowDefinition } from "@chengchenccc/workflow";
import { useMemo, useState } from "react";
import { ChatPanel } from "./ChatPanel";
import { DslEditorPanel } from "./DslEditorPanel";
import { NodePropertyPanel } from "./NodePropertyPanel";
import { WorkflowCanvas } from "./WorkflowCanvas";

type Tab = "attrs" | "dsl" | "chat";

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
  const graph = useMemo(() => (definition ? toEditorGraph(definition) : null), [definition]);

  return (
    <div className="flex h-full">
      <div className="flex-1 border-r">
        {graph ? (
          <WorkflowCanvas
            graph={graph}
            onSelect={(id) => {
              setActiveId(id);
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
        {tab === "attrs" && activeId && definition ? (
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
