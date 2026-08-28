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
import type { EditorGraph } from "@chengchenccc/workflow";
import { useEffect, useState } from "react";
import { WorkflowNodeCard } from "./workflow-node";

export type NodeStatus = "done" | "active" | "idle" | "failed";

function shortWhen(when: unknown): string {
  try {
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

function buildGraph(
  graph: EditorGraph,
  nodeStatus: Record<string, NodeStatus> | undefined,
  litEdges: Set<string> | undefined,
  interactive: boolean,
  onNodeDelete: ((id: string) => void) | undefined,
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
}) {
  const [rf, setRf] = useState<{
    fitView: (opts?: { padding?: number }) => void;
    screenToFlowPosition?: (pos: { x: number; y: number }) => { x: number; y: number };
  } | null>(null);
  const [connectSource, setConnectSource] = useState<string | null>(null);
  const nodeTypes = { default: WorkflowNodeCard };

  const [nodes, setNodes] = useState<Node[]>(
    () => buildGraph(graph, nodeStatus, litEdges, interactive, onNodeDelete).nodes,
  );
  const [edges, setEdges] = useState<Edge[]>(
    () => buildGraph(graph, nodeStatus, litEdges, interactive, onNodeDelete).edges,
  );

  // Sync graph changes without resetting drag positions: keep existing node
  // positions, only place new nodes via the derived layout. Auto-layout (button)
  // is the only thing that repositions the whole graph.
  useEffect(() => {
    const b = buildGraph(graph, nodeStatus, litEdges, interactive, onNodeDelete);
    setNodes((existing) => {
      const pos = new Map(existing.map((n) => [n.id, n.position]));
      return b.nodes.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position }));
    });
    setEdges(b.edges);
  }, [graph, nodeStatus, litEdges, interactive, onNodeDelete]);

  function autoLayout() {
    const b = buildGraph(graph, nodeStatus, litEdges, interactive, onNodeDelete);
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
    if (!source) return;
    if (
      "connection" in event &&
      (event.connection as { target?: string } | null | undefined)?.target
    )
      return; // connected to a node
    const x = "clientX" in event ? event.clientX : 0;
    const y = "clientY" in event ? event.clientY : 0;
    onNodeMenuRequested?.(source, { x, y });
    setConnectSource(null);
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
        onConnect={onConnect ? (c) => onConnect(c.source!, c.target!) : undefined}
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
        {interactive && (
          <MiniMap
            pannable
            zoomable
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
        <div className="pointer-events-none absolute left-4 top-4 z-10 rounded-md border border-(--hairline) bg-(--panel)/90 px-3 py-2 text-[11px] text-(--mute) backdrop-blur">
          <span className="mr-2 inline-block size-1.5 rounded-full bg-[#38bdf8]" />
          从节点底部拖出连线到空白处，选择下游节点类型；点击节点可编辑，按 Delete 删除
        </div>
      )}
      {interactive && (
        <button
          onClick={autoLayout}
          title="Auto layout"
          className="absolute right-4 top-4 z-10 flex size-7 items-center justify-center rounded-md border border-(--hairline) bg-(--panel)/90 text-(--mute) hover:border-(--info)/50 hover:text-(--info)"
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
        </button>
      )}
    </div>
  );
}
