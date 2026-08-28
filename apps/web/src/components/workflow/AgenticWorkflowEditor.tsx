"use client";

import type { AskQuestionInput } from "@chengchenccc/agent-contract";
import {
  parseWorkflow,
  toEditorGraph,
  type WorkflowDefinition,
  type WorkflowNode,
} from "@chengchenccc/workflow";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api";
import { ChatPanel } from "./ChatPanel";

const DslEditorPanel = dynamic(() => import("./DslEditorPanel").then((m) => m.DslEditorPanel), {
  ssr: false,
  loading: () => <div className="p-4 text-xs text-(--mute)">Loading editor…</div>,
}) as React.ComponentType<{
  workflowId: string;
  definition: WorkflowDefinition;
  onChange: (next: WorkflowDefinition) => void;
}>;

import { EdgePropertyPanel } from "./EdgePropertyPanel";
import { InputPanel } from "./InputPanel";
import { NodeMenuPopover } from "./NodeMenuPopover";
import { NodePanel } from "./NodePanel";
import { NodePropertyPanel } from "./NodePropertyPanel";
import { TriggerPanel } from "./TriggerPanel";
import { WorkflowCanvas } from "./WorkflowCanvas";

type InspectorTab = "attrs" | "palette" | "triggers" | "input";

function formToQuestions(
  form: Record<string, unknown> | undefined,
  question: string | undefined,
): AskQuestionInput {
  const questions: AskQuestionInput["questions"] = [];
  for (const [key, raw] of Object.entries(form ?? {})) {
    const f = raw as { type?: string; label?: string; options?: string[]; required?: boolean };
    const label = f.label ?? key;
    if (f.type === "enum") {
      questions.push({
        id: key,
        kind: "select",
        question: label,
        header: question,
        options: (f.options ?? []).map((v) => ({ value: v, label: v })),
        validation: { required: f.required !== false },
      });
    } else if (f.type === "boolean") {
      questions.push({
        id: key,
        kind: "select",
        question: label,
        header: question,
        options: [
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
        ],
        validation: { required: f.required !== false },
      });
    } else {
      questions.push({
        id: key,
        kind: "text",
        question: label,
        header: question,
        multiline: f.type === "textarea",
        placeholder: f.label,
        validation: { required: f.required !== false },
      });
    }
  }
  if (questions.length === 0 && question)
    questions.push({ id: "answer", kind: "text", question, multiline: true });
  return { questions };
}

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
  const [inspectorW, setInspectorW] = useState(288);
  const [chatW, setChatW] = useState(320);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeEdgeIndex, setActiveEdgeIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ sourceId: string; x: number; y: number } | null>(null);
  const [validation, setValidation] = useState<{ ok: boolean; errors?: string[] } | null>(null);

  const graph = useMemo(() => (definition ? toEditorGraph(definition) : null), [definition]);
  const humanForms = useMemo(() => {
    const map: Record<string, AskQuestionInput> = {};
    if (!definition) return map;
    for (const n of definition.nodes) {
      if (n.type === "human") {
        const q = (n as { question?: string }).question;
        const form = (n as { form?: Record<string, unknown> }).form;
        if (form || q) map[n.id] = formToQuestions(form, q);
      }
    }
    return map;
  }, [definition]);
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
    <div className="flex h-full flex-col bg-(--canvas) text-(--ink)">
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-(--hairline) px-4">
        <Breadcrumb className="min-w-0">
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/agentic-workflow">Workflows</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage className="truncate">
                {meta?.name ?? workflowId}
                {meta?.status && (
                  <span className="ml-1.5 rounded-full border border-(--hairline) px-2 py-0.5 text-[10px] text-(--mute)">
                    {meta.status}
                  </span>
                )}
              </BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <div className="ml-auto flex items-center gap-2">
          {savedAt && (
            <span className="font-mono text-[10px] text-(--primary)">
              saved {new Date(savedAt).toLocaleTimeString()}
            </span>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger className="rounded-md border border-(--hairline) px-2.5 py-1 text-xs text-(--mute) hover:text-(--ink)">
              •••
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-36">
              <DropdownMenuItem
                onClick={() => window.location.assign(`/agentic-workflow/${workflowId}/executions`)}
              >
                Executions
              </DropdownMenuItem>
              <DropdownMenuItem disabled={past.length === 0} onClick={undo}>
                ↩ Undo
              </DropdownMenuItem>
              <DropdownMenuItem disabled={future.length === 0} onClick={redo}>
                ↪ Redo
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="flex overflow-hidden rounded-md border border-(--hairline)">
            <button
              onClick={() => setMode("canvas")}
              className={`px-2.5 py-1 text-xs ${mode === "canvas" ? "bg-(--panel2) text-(--ink)" : "text-(--mute)"}`}
            >
              Canvas
            </button>
            <button
              onClick={() => setMode("dsl")}
              className={`px-2.5 py-1 text-xs ${mode === "dsl" ? "bg-(--panel2) text-(--ink)" : "text-(--mute)"}`}
            >
              DSL
            </button>
          </div>
          <button
            onClick={validate}
            className="rounded-md border border-[#38bdf8]/40 bg-[#38bdf8]/10 px-3 py-1 text-xs text-(--info) transition-all hover:bg-[#38bdf8]/20 hover:shadow-[0_0_16px_rgba(56,189,248,0.2)]"
          >
            Validate
          </button>
          <button
            onClick={save}
            disabled={saving || !definition}
            className="rounded-md border border-(--primary)/40 bg-(--primary)/10 px-3 py-1 text-xs text-(--primary) transition-all hover:bg-(--primary)/20 hover:shadow-[0_0_16px_rgba(245,158,11,0.25)] disabled:opacity-40"
          >
            {saving ? "saving…" : "⌘S Save"}
          </button>
        </div>
      </div>

      {validation && (
        <div
          className={`shrink-0 border-b px-4 py-1.5 text-xs ${
            validation.ok
              ? "border-(--primary)/30 bg-(--primary)/10 text-(--primary)"
              : "border-[#fb7185]/30 bg-[#fb7185]/10 text-(--err)"
          }`}
        >
          {validation.ok ? "✓ DSL 合法" : `✗ 校验失败：${(validation.errors ?? []).join("；")}`}
        </div>
      )}

      {/* Editor (left) + Chat (right) */}
      <div className="flex min-h-0 flex-1">
        {mode === "dsl" ? (
          <div className="min-w-0 flex-1 bg-(--canvas)">
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
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="min-h-0 flex-1">
                {menu && (
                  <div className="fixed z-50" style={{ left: menu.x, top: menu.y }}>
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
                    humanForms={humanForms}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-(--mute)">
                    No workflow loaded.
                  </div>
                )}
              </div>
            </div>

            {/* Resize handle between canvas and inspector */}
            <div
              onPointerDown={(e) => {
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                const startX = e.clientX;
                const startW = inspectorW;
                const move = (ev: React.PointerEvent) => {
                  setInspectorW(Math.max(220, startW + ev.clientX - startX));
                };
                const up = () => {
                  e.currentTarget.removeEventListener("pointermove", move as never);
                  e.currentTarget.removeEventListener("pointerup", up as never);
                };
                e.currentTarget.addEventListener("pointermove", move as never);
                e.currentTarget.addEventListener("pointerup", up as never);
              }}
              className="w-1.5 cursor-col-resize bg-(--hairline) transition-colors hover:bg-(--info)/50 touch-none"
            />
            {/* Inspector column */}
            <div
              className="flex shrink-0 flex-col border-l border-(--hairline) bg-(--panel)/70"
              style={{ width: inspectorW, minWidth: inspectorW }}
            >
              <div className="flex border-b border-(--hairline)">
                {(
                  [
                    ["attrs", "属性"],
                    ["palette", "节点"],
                    ["triggers", "定时"],
                    ["input", "输入"],
                  ] as Array<[InspectorTab, string]>
                ).map(([k, label]) => (
                  <button
                    key={k}
                    className={`flex-1 py-2.5 text-xs transition-colors ${
                      inspectorTab === k
                        ? "border-b-2 border-(--primary) text-(--ink)"
                        : "text-(--mute) hover:text-(--mute)"
                    }`}
                    onClick={() => setInspectorTab(k)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {inspectorTab === "input" && definition ? (
                  <InputPanel definition={definition} onChange={setDefinitionTracked} />
                ) : inspectorTab === "triggers" && definition ? (
                  <TriggerPanel definition={definition} onChange={setDefinitionTracked} />
                ) : inspectorTab === "palette" ? (
                  <NodePanel
                    onAdd={(node) => {
                      if (!definition) return;
                      const id = makeNodeId(node.type);
                      setDefinitionTracked(addNode(definition, { ...node, id }));
                      setActiveId(id);
                      setActiveEdgeIndex(null);
                      setInspectorTab("attrs");
                    }}
                  />
                ) : activeEdgeIndex !== null && definition ? (
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
                    workflowId={workflowId}
                    nodeId={activeId}
                    definition={definition}
                    onChange={setDefinitionTracked}
                  />
                ) : (
                  <div className="p-4 text-xs text-(--mute)">
                    点击画布节点或边进行编辑；切到「节点」tab
                    添加，或拖控制线到空白处；拖动节点调整布局。
                  </div>
                )}
              </div>
            </div>

            {/* Resize handle between inspector and chat */}
            {definition && (
              <div
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  const startX = e.clientX;
                  const startW = chatW;
                  const move = (ev: React.PointerEvent) => {
                    setChatW(Math.max(260, startW - ev.clientX + startX));
                  };
                  const up = () => {
                    e.currentTarget.removeEventListener("pointermove", move as never);
                    e.currentTarget.removeEventListener("pointerup", up as never);
                  };
                  e.currentTarget.addEventListener("pointermove", move as never);
                  e.currentTarget.addEventListener("pointerup", up as never);
                }}
                className="w-1.5 cursor-col-resize bg-(--hairline) transition-colors hover:bg-(--info)/50 touch-none"
              />
            )}
            {/* Chat (right, always visible) */}
            {definition && (
              <div
                className="flex shrink-0 flex-col border-l border-(--hairline) bg-(--panel)/70"
                style={{ width: chatW, minWidth: chatW }}
              >
                <ChatPanel
                  workflowId={workflowId}
                  definition={definition}
                  onApply={(def) => {
                    setDefinitionTracked(def);
                    setActiveId(null);
                    setActiveEdgeIndex(null);
                  }}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
