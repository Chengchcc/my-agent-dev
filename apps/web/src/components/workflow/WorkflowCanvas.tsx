"use client";

import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  type EdgeChange,
  MiniMap,
  type Node,
  type NodeChange,
  type OnConnectEnd,
  ReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { AskQuestionInput } from "@chengchenccc/agent-contract";
import type { EditorGraph } from "@chengchenccc/workflow";
import { useEffect, useRef, useState } from "react";
import { WorkflowNodeCard } from "./workflow-node";

export type NodeStatus = "done" | "active" | "idle" | "failed";

function shortWhen(when: unknown): string {
  try {
    if (typeof when === "string" && when.length > 0) when = JSON.parse(when);
    const w = when as Record<string, unknown> | undefined;
    if (!w) return "";
    const op = Object.keys(w)[0] ?? "";
    const args = (w[op] as unknown[] | undefined) ?? [];
    if ((op === "==" || op === "!=") && Array.isArray(args) && args.length === 2) {
      const a = args[0] as { var?: string } | string | undefined;
      const path = typeof a === "object" && a && "var" in a ? String(a.var) : String(a);
      return `${path.split(".").pop()} ${op === "==" ? "==" : "!="} ${JSON.stringify(args[1])}`;
    }
    return op;
  } catch {
    return "";
  }
}

type PendingHuman = {
  nodeId: string;
  question?: string;
  form?: Record<string, unknown>;
  status: string;
};

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

function buildGraph(
  graph: EditorGraph,
  nodeStatus: Record<string, NodeStatus> | undefined,
  litEdges: Set<string> | undefined,
  interactive: boolean,
  onNodeDelete: ((id: string) => void) | undefined,
  pendingHuman?: PendingHuman | null,
  onSubmitHuman?: (nodeId: string, answer: Record<string, unknown>) => void | Promise<void>,
  humanForms?: Record<string, AskQuestionInput>,
  upstreamArtifacts?: Array<{ url: string; from: string; content?: string }>,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = graph.nodes.map((n) => {
    const status = nodeStatus?.[n.id] ?? "idle";
    return {
      id: n.id,
      type: "default",
      position: { x: n.x, y: n.y },
      data: {
        label: n.label,
        type: n.type,
        layer: n.layer,
        status,
        ...(interactive && onNodeDelete ? { onDelete: () => onNodeDelete(n.id) } : {}),
        ...(n.type === "human"
          ? {
              askQuestion:
                pendingHuman?.nodeId === n.id
                  ? formToQuestions(pendingHuman.form, pendingHuman.question)
                  : (humanForms?.[n.id] ?? { questions: [] }),
              ...(pendingHuman?.nodeId === n.id
                ? {
                    onSubmitHuman: async (answer: Record<string, unknown>) =>
                      onSubmitHuman?.(n.id, answer),
                    upstreamArtifacts: upstreamArtifacts ?? [],
                  }
                : {}),
            }
          : {}),
      },
      opacity: status === "idle" && nodeStatus ? 0.45 : 1,
    };
  });
  const edges: Edge[] = graph.edges.map((e) => {
    const lit = litEdges?.has(`${e.from}->${e.to}`) ?? false;
    return {
      id: e.id,
      source: e.from,
      target: e.to,
      label: shortWhen(e.label),
      style: lit
        ? {
            stroke: "var(--wf-accent)",
            strokeWidth: 2,
            strokeDasharray: "8 6",
            filter: "drop-shadow(0 0 6px rgba(245,158,11,0.6))",
          }
        : undefined,
      animated: lit,
    };
  });
  return { nodes, edges };
}

export function WorkflowCanvas({
  graph,
  onSelect,
  nodeStatus,
  litEdges,
  interactive = false,
  onConnect,
  onNodeDelete,
  onEdgeSelect,
  onNodeMenuRequested,
  pendingHuman,
  onSubmitHuman,
  humanForms,
  upstreamArtifacts,
}: {
  graph: EditorGraph;
  onSelect?: (id: string) => void;
  nodeStatus?: Record<string, NodeStatus>;
  litEdges?: Set<string>;
  interactive?: boolean;
  onConnect?: (from: string, to: string) => void;
  onNodeDelete?: (id: string) => void;
  onEdgeSelect?: (edgeIndex: number) => void;
  /** User dragged an edge from a node and dropped on empty canvas → show
   *  the "add downstream node" menu. */
  onNodeMenuRequested?: (sourceId: string, position: { x: number; y: number }) => void;
  pendingHuman?: {
    nodeId: string;
    question?: string;
    form?: Record<string, unknown>;
    status: string;
  } | null;
  onSubmitHuman?: (nodeId: string, answer: Record<string, unknown>) => void | Promise<void>;
  humanForms?: Record<string, AskQuestionInput>;
  upstreamArtifacts?: Array<{ url: string; from: string; content?: string }>;
}) {
  const [rf, setRf] = useState<{
    fitView: (opts?: { padding?: number }) => void;
    screenToFlowPosition?: (pos: { x: number; y: number }) => { x: number; y: number };
  } | null>(null);
  const [connectSource, setConnectSource] = useState<string | null>(null);
  const [minimapOpen, setMinimapOpen] = useState(true);
  const [hintDismissed, setHintDismissed] = useState(true);
  useEffect(() => {
    if (localStorage.getItem("wf-hint-dismissed") !== "1") setHintDismissed(false);
  }, []);
  const connectedRef = useRef(false);
  const nodeTypes = { default: WorkflowNodeCard };

  const [nodes, setNodes] = useState<Node[]>(
    () =>
      buildGraph(
        graph,
        nodeStatus,
        litEdges,
        interactive,
        onNodeDelete,
        pendingHuman,
        onSubmitHuman,
        humanForms,
        upstreamArtifacts,
      ).nodes,
  );
  const [edges, setEdges] = useState<Edge[]>(
    () =>
      buildGraph(
        graph,
        nodeStatus,
        litEdges,
        interactive,
        onNodeDelete,
        pendingHuman,
        onSubmitHuman,
        humanForms,
        upstreamArtifacts,
      ).edges,
  );

  // Sync graph changes without resetting drag positions: keep existing node
  // positions, only place new nodes via the derived layout. Auto-layout (button)
  // is the only thing that repositions the whole graph.
  useEffect(() => {
    const b = buildGraph(
      graph,
      nodeStatus,
      litEdges,
      interactive,
      onNodeDelete,
      pendingHuman,
      onSubmitHuman,
      humanForms,
      upstreamArtifacts,
    );
    setNodes((existing) => {
      const pos = new Map(existing.map((n) => [n.id, n.position]));
      return b.nodes.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position }));
    });
    setEdges(b.edges);
  }, [
    graph,
    nodeStatus,
    litEdges,
    interactive,
    onNodeDelete,
    pendingHuman,
    onSubmitHuman,
    humanForms,
    upstreamArtifacts,
  ]);

  function autoLayout() {
    const b = buildGraph(
      graph,
      nodeStatus,
      litEdges,
      interactive,
      onNodeDelete,
      pendingHuman,
      onSubmitHuman,
      humanForms,
      upstreamArtifacts,
    );
    setNodes(b.nodes);
    rf?.fitView({ padding: 0.2 });
  }

  function onNodesChange(changes: NodeChange[]) {
    setNodes((nds) => applyNodeChanges(changes, nds));
  }
  function onEdgesChange(changes: EdgeChange[]) {
    setEdges((eds) => applyEdgeChanges(changes, eds));
  }
  function onConnectStart(
    _: unknown,
    params: { nodeId?: string | null; handleId?: string | null },
  ) {
    setConnectSource(params.nodeId ?? null);
  }
  const onConnectEnd: OnConnectEnd = (event) => {
    const source = connectSource;
    setConnectSource(null);
    if (!source) return;
    if (connectedRef.current) {
      connectedRef.current = false;
      return;
    } // dropped onto a node
    const x = "clientX" in event ? event.clientX : 0;
    const y = "clientY" in event ? event.clientY : 0;
    onNodeMenuRequested?.(source, { x, y });
  };

  return (
    <div
      className="relative"
      style={{
        background: "var(--wf-canvas-bg)",
        height: "100%",
        width: "100%",
        cursor: interactive ? "crosshair" : "default",
      }}
    >
      <ReactFlow
        nodeTypes={nodeTypes}
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodesDraggable={interactive}
        nodesConnectable={interactive}
        elementsSelectable={interactive}
        fitView
        onNodeClick={onSelect ? (_, node) => onSelect(node.id) : undefined}
        onConnect={
          onConnect
            ? (c) => {
                connectedRef.current = true;
                onConnect(c.source!, c.target!);
              }
            : undefined
        }
        onConnectStart={onNodeMenuRequested ? onConnectStart : undefined}
        onConnectEnd={onNodeMenuRequested ? onConnectEnd : undefined}
        onNodesDelete={
          onNodeDelete
            ? (ns) =>
                ns.forEach((n) => {
                  onNodeDelete(n.id);
                })
            : undefined
        }
        onEdgeClick={
          onEdgeSelect ? (_, e) => onEdgeSelect(Number(e.id.replace(/^e/, ""))) : undefined
        }
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={interactive ? ["Delete", "Backspace"] : null}
        onInit={(instance) => setRf(instance as never)}
      >
        <Background variant={BackgroundVariant.Lines} gap={24} size={1} color="var(--wf-grid)" />
        {interactive && minimapOpen && (
          <MiniMap
            pannable
            zoomable
            bgColor="rgba(11,14,20,0.92)"
            maskColor="rgba(11,14,20,0.75)"
            nodeColor={(n: Node) => {
              const t = (n.data as unknown as { type?: string }).type;
              return (
                {
                  start: "#34d399",
                  end: "#fb7185",
                  agent: "#38bdf8",
                  script: "#f59e0b",
                  human: "#a78bfa",
                }[t ?? ""] ?? "#334155"
              );
            }}
            style={{
              background: "#0b0e14",
              border: "1px solid var(--wf-node-border)",
              borderRadius: 8,
            }}
          />
        )}
        {interactive && (
          <Controls
            showInteractive={false}
            style={{
              border: "1px solid var(--wf-node-border)",
              borderRadius: 8,
              background: "var(--wf-node-bg)",
              overflow: "hidden",
            }}
          />
        )}
      </ReactFlow>
      {interactive && (
        <button
          onClick={() => setMinimapOpen((v) => !v)}
          title={minimapOpen ? "Hide minimap" : "Show minimap"}
          className="absolute bottom-16 right-4 z-10 flex h-7 items-center gap-1 rounded-md border border-(--hairline) bg-(--panel)/90 px-2 text-[10px] text-(--mute) hover:text-(--info)"
        >
          {minimapOpen ? "Hide minimap" : "Minimap"}
        </button>
      )}
      {interactive && !hintDismissed && (
        <div className="absolute left-4 top-4 z-10 flex items-start gap-2 rounded-md border border-(--hairline) bg-(--panel)/90 px-3 py-2 text-[11px] text-(--mute) backdrop-blur">
          <span className="inline-block size-1.5 translate-y-1 rounded-full bg-[#38bdf8]" />
          <span>
            Drag a line from the bottom of a node onto empty canvas to pick a downstream node type;
            click a node to edit, press Delete to remove
          </span>
          <button
            onClick={() => {
              setHintDismissed(true);
              localStorage.setItem("wf-hint-dismissed", "1");
            }}
            className="shrink-0 rounded p-0.5 text-(--mute) hover:text-(--ink)"
            title="Close hint"
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
      {interactive && (
        <button
          onClick={autoLayout}
          title="Auto layout"
          className="absolute right-4 top-4 z-10 flex h-7 items-center gap-1.5 rounded-md border border-(--hairline) bg-(--panel)/90 px-2.5 text-[11px] text-(--mute) hover:border-(--info)/50 hover:text-(--info)"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 3 3 21" />
            <path d="M21 7v4h-4" />
            <path d="M3 17v-4h4" />
          </svg>
          <span>Auto layout</span>
        </button>
      )}
    </div>
  );
}
