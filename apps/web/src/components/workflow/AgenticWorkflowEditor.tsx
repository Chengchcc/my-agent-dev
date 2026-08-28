"use client";

import { toEditorGraph, type WorkflowDefinition, type WorkflowNode } from "@chengchenccc/workflow";
import Link from "next/link";
import { useMemo, useState } from "react";
import { api } from "@/lib/api";
import { ChatPanel } from "./ChatPanel";
import { DslEditorPanel } from "./DslEditorPanel";
import { EdgePropertyPanel } from "./EdgePropertyPanel";
import { NodePalette } from "./NodePalette";
import { NodePropertyPanel } from "./NodePropertyPanel";
import { WorkflowCanvas } from "./WorkflowCanvas";

type InspectorTab = "attrs" | "dsl";

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
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("attrs");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeEdgeIndex, setActiveEdgeIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const graph = useMemo(() => (definition ? toEditorGraph(definition) : null), [definition]);
  const meta = definition?.meta;

  async function save() {
    if (!definition) return;
    setSaving(true);
    try {
      await api.saveWorkflowDefinition(
        workflowId,
        definition as unknown as Record<string, unknown>,
      );
      setSavedAt(Date.now());
    } catch (err) {
      alert(`Save failed: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full flex-col bg-[#0b0e14] text-[#e5e7eb]">
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-[#1f2937] px-4">
        <Link href="/agentic-workflow" className="text-xs text-[#38bdf8] hover:text-[#f59e0b]">
          ← workflows
        </Link>
        <span className="font-mono text-xs text-[#475569]">/</span>
        <span className="truncate font-medium">{meta?.name ?? workflowId}</span>
        {meta?.status && (
          <span className="rounded-full border border-[#1f2937] px-2 py-0.5 text-[10px] text-[#94a3b8]">
            {meta.status}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {savedAt && (
            <span className="font-mono text-[10px] text-[#34d399]">
              saved {new Date(savedAt).toLocaleTimeString()}
            </span>
          )}
          <Link
            href={`/agentic-workflow/${workflowId}/executions`}
            className="rounded-md border border-[#1f2937] px-2.5 py-1 text-xs text-[#94a3b8] hover:border-[#38bdf8]/50 hover:text-[#38bdf8]"
          >
            executions
          </Link>
          <button
            onClick={save}
            disabled={saving || !definition}
            className="rounded-md border border-[#f59e0b]/40 bg-[#f59e0b]/10 px-3 py-1 text-xs text-[#f59e0b] transition-all hover:bg-[#f59e0b]/20 hover:shadow-[0_0_16px_rgba(245,158,11,0.25)] disabled:opacity-40"
          >
            {saving ? "saving…" : "⌘S Save"}
          </button>
        </div>
      </div>

      {/* Editor (left) + Chat (right) */}
      <div className="flex min-h-0 flex-1">
        {/* Editor: canvas + inspector */}
        <div className="flex min-w-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            {definition && (
              <div className="border-b border-[#1f2937]">
                <NodePalette
                  onAdd={(node) =>
                    setDefinition(addNode(definition, { ...node, id: makeNodeId(node.type) }))
                  }
                />
              </div>
            )}
            <div className="min-h-0 flex-1">
              {graph && definition ? (
                <WorkflowCanvas
                  graph={graph}
                  interactive
                  onSelect={(id) => {
                    setActiveId(id);
                    setActiveEdgeIndex(null);
                    setInspectorTab("attrs");
                  }}
                  onConnect={(from, to) => setDefinition(addEdge(definition, from, to))}
                  onNodeDelete={(id) => setDefinition(deleteNode(definition, id))}
                  onEdgeSelect={(i) => {
                    setActiveEdgeIndex(i);
                    setActiveId(null);
                    setInspectorTab("attrs");
                  }}
                />
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-[#64748b]">
                  No workflow loaded.
                </div>
              )}
            </div>
          </div>

          {/* Inspector column */}
          <div className="flex w-72 shrink-0 flex-col border-l border-[#1f2937] bg-[#0f172a]/70">
            <div className="flex border-b border-[#1f2937]">
              {(
                [
                  ["attrs", "属性"],
                  ["dsl", "DSL"],
                ] as Array<[InspectorTab, string]>
              ).map(([k, label]) => (
                <button
                  key={k}
                  className={`flex-1 py-2.5 text-xs transition-colors ${
                    inspectorTab === k
                      ? "border-b-2 border-[#f59e0b] text-[#e5e7eb]"
                      : "text-[#64748b] hover:text-[#94a3b8]"
                  }`}
                  onClick={() => setInspectorTab(k)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {inspectorTab === "dsl" ? (
                <DslEditorPanel
                  workflowId={workflowId}
                  definition={definition}
                  onChange={setDefinition}
                />
              ) : activeEdgeIndex !== null && definition ? (
                <EdgePropertyPanel
                  edgeIndex={activeEdgeIndex}
                  definition={definition}
                  onChange={setDefinition}
                />
              ) : activeId && definition ? (
                <NodePropertyPanel
                  nodeId={activeId}
                  definition={definition}
                  onChange={setDefinition}
                />
              ) : (
                <div className="p-4 text-xs text-[#64748b]">
                  点击画布节点或边进行编辑；上方按钮添加节点；拖动节点调整布局。
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Chat (right, always visible) */}
        <div className="flex w-80 shrink-0 flex-col border-l border-[#1f2937] bg-[#0f172a]/70">
          <ChatPanel />
        </div>
      </div>
    </div>
  );
}
