"use client";

import {
  parseWorkflow,
  toEditorGraph,
  type WorkflowDefinition,
  type WorkflowNode,
} from "@chengchenccc/workflow";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { ChatPanel } from "./ChatPanel";
import { DslEditorPanel } from "./DslEditorPanel";
import { EdgePropertyPanel } from "./EdgePropertyPanel";
import { NodeMenuPopover } from "./NodeMenuPopover";
import { NodePanel } from "./NodePanel";
import { NodePropertyPanel } from "./NodePropertyPanel";
import { WorkflowCanvas } from "./WorkflowCanvas";

type InspectorTab = "attrs";

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
  const [past, setPast] = useState<WorkflowDefinition[]>([]);
  const [future, setFuture] = useState<WorkflowDefinition[]>([]);
  const [mode, setMode] = useState<"canvas" | "dsl">("canvas");
  const definitionRef = useRef<WorkflowDefinition | null>(initial);
  definitionRef.current = definition;

  // Central setter that records history for undo/redo (except for explicit
  // `commit: false` calls like initial hydration).
  const setDefinitionTracked = useCallback(
    (
      next: WorkflowDefinition | ((prev: WorkflowDefinition | null) => WorkflowDefinition | null),
    ) => {
      const prev = definitionRef.current;
      const resolved = typeof next === "function" ? next(prev) : next;
      if (!prev || !resolved || prev === resolved) {
        setDefinition(resolved);
        return;
      }
      setPast((p) => [...p.slice(-49), prev]);
      setFuture([]);
      setDefinition(resolved);
      definitionRef.current = resolved;
    },
    [],
  );

  const undo = useCallback(() => {
    setPast((p) => {
      if (p.length === 0) return p;
      const prevState = p[p.length - 1]!;
      const cur = definitionRef.current;
      setFuture((f) => (cur ? [...f, cur] : f));
      setPast((pp) => pp.slice(0, -1));
      setDefinition(prevState);
      definitionRef.current = prevState;
      return p;
    });
  }, []);
  const redo = useCallback(() => {
    setFuture((f) => {
      if (f.length === 0) return f;
      const nextState = f[f.length - 1]!;
      const cur = definitionRef.current;
      setPast((p) => (cur ? [...p, cur] : p));
      setFuture((ff) => ff.slice(0, -1));
      setDefinition(nextState);
      definitionRef.current = nextState;
      return f;
    });
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("attrs");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeEdgeIndex, setActiveEdgeIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ sourceId: string; x: number; y: number } | null>(null);
  const [validation, setValidation] = useState<{ ok: boolean; errors?: string[] } | null>(null);

  const graph = useMemo(() => (definition ? toEditorGraph(definition) : null), [definition]);
  const meta = definition?.meta;

  function validate() {
    if (!definition) return;
    try {
      parseWorkflow(definition);
      setValidation({ ok: true });
    } catch (err) {
      const issues = (err as { issues?: string[] }).issues ?? [(err as Error).message];
      setValidation({ ok: false, errors: issues });
    }
  }

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
            onClick={undo}
            disabled={past.length === 0}
            className="rounded-md border border-[#1f2937] px-2.5 py-1 text-xs text-[#94a3b8] hover:text-[#e5e7eb] disabled:opacity-30"
          >
            ↩ Undo
          </button>
          <button
            onClick={redo}
            disabled={future.length === 0}
            className="rounded-md border border-[#1f2937] px-2.5 py-1 text-xs text-[#94a3b8] hover:text-[#e5e7eb] disabled:opacity-30"
          >
            ↪ Redo
          </button>
          <div className="flex overflow-hidden rounded-md border border-[#1f2937]">
            <button
              onClick={() => setMode("canvas")}
              className={`px-2.5 py-1 text-xs ${mode === "canvas" ? "bg-[#1e293b] text-[#e5e7eb]" : "text-[#64748b]"}`}
            >
              Canvas
            </button>
            <button
              onClick={() => setMode("dsl")}
              className={`px-2.5 py-1 text-xs ${mode === "dsl" ? "bg-[#1e293b] text-[#e5e7eb]" : "text-[#64748b]"}`}
            >
              DSL
            </button>
          </div>
          <button
            onClick={validate}
            className="rounded-md border border-[#38bdf8]/40 bg-[#38bdf8]/10 px-3 py-1 text-xs text-[#38bdf8] transition-all hover:bg-[#38bdf8]/20 hover:shadow-[0_0_16px_rgba(56,189,248,0.2)]"
          >
            Validate
          </button>
          <button
            onClick={save}
            disabled={saving || !definition}
            className="rounded-md border border-[#f59e0b]/40 bg-[#f59e0b]/10 px-3 py-1 text-xs text-[#f59e0b] transition-all hover:bg-[#f59e0b]/20 hover:shadow-[0_0_16px_rgba(245,158,11,0.25)] disabled:opacity-40"
          >
            {saving ? "saving…" : "⌘S Save"}
          </button>
        </div>
      </div>

      {validation && (
        <div
          className={`shrink-0 border-b px-4 py-1.5 text-xs ${
            validation.ok
              ? "border-[#34d399]/30 bg-[#34d399]/10 text-[#34d399]"
              : "border-[#fb7185]/30 bg-[#fb7185]/10 text-[#fb7185]"
          }`}
        >
          {validation.ok ? "✓ DSL 合法" : `✗ 校验失败：${(validation.errors ?? []).join("；")}`}
        </div>
      )}

      {/* Editor (left) + Chat (right) */}
      <div className="flex min-h-0 flex-1">
        {mode === "dsl" ? (
          <div className="min-w-0 flex-1 bg-[#0b0e14]">
            {definition && (
              <DslEditorPanel
                workflowId={workflowId}
                definition={definition}
                onChange={setDefinitionTracked}
              />
            )}
          </div>
        ) : (
          <div className="flex min-w-0 flex-1">
            <NodePanel
              onAdd={(node) => {
                if (!definition) return;
                setDefinitionTracked(addNode(definition, { ...node, id: makeNodeId(node.type) }));
              }}
            />
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="min-h-0 flex-1">
                {menu && (
                  <div className="absolute z-20" style={{ left: menu.x, top: menu.y }}>
                    <NodeMenuPopover
                      onPick={(node) => {
                        if (!definition) return;
                        const id = makeNodeId(node.type);
                        setDefinitionTracked(
                          addNode(addEdge(definition, menu.sourceId, id), { ...node, id }),
                        );
                      }}
                      onClose={() => setMenu(null)}
                    />
                  </div>
                )}
                {graph && definition ? (
                  <WorkflowCanvas
                    graph={graph}
                    interactive
                    onSelect={(id) => {
                      setActiveId(id);
                      setActiveEdgeIndex(null);
                      setInspectorTab("attrs");
                    }}
                    onConnect={(from, to) => setDefinitionTracked(addEdge(definition, from, to))}
                    onNodeDelete={(id) => setDefinitionTracked(deleteNode(definition, id))}
                    onEdgeSelect={(i) => {
                      setActiveEdgeIndex(i);
                      setActiveId(null);
                      setInspectorTab("attrs");
                    }}
                    onNodeMenuRequested={(sourceId, pos) =>
                      setMenu({ sourceId, x: pos.x, y: pos.y })
                    }
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
                {([["attrs", "属性"]] as Array<[InspectorTab, string]>).map(([k, label]) => (
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
                {activeEdgeIndex !== null && definition ? (
                  <EdgePropertyPanel
                    edgeIndex={activeEdgeIndex}
                    definition={definition}
                    onChange={setDefinitionTracked}
                    onDelete={(def) => {
                      setDefinitionTracked(def);
                      setActiveEdgeIndex(null);
                    }}
                  />
                ) : activeId && definition ? (
                  <NodePropertyPanel
                    nodeId={activeId}
                    definition={definition}
                    onChange={setDefinitionTracked}
                  />
                ) : (
                  <div className="p-4 text-xs text-[#64748b]">
                    点击画布节点或边进行编辑；上方按钮添加节点；拖动节点调整布局。
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
        {/* Chat (right, always visible) */}
        <div className="flex w-80 shrink-0 flex-col border-l border-[#1f2937] bg-[#0f172a]/70">
          <ChatPanel />
        </div>
      </div>
    </div>
  );
}
