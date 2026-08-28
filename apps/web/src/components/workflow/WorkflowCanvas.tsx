"use client";

import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type OnConnectEnd,
  ReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { EditorGraph } from "@chengchenccc/workflow";
import { useEffect, useState } from "react";
import { WorkflowNodeCard } from "./workflow-node";

export type NodeStatus = "done" | "active" | "idle";

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
      label: e.label,
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

  // Rebuild when the derived graph changes; local drag positions persist
  // across re-renders of the same graph (drag is view-only, never in DSL).
  useEffect(() => {
    const b = buildGraph(graph, nodeStatus, litEdges, interactive, onNodeDelete);
    setNodes(b.nodes);
    setEdges(b.edges);
  }, [graph, nodeStatus, litEdges, interactive, onNodeDelete]);

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
    const pos = rf?.screenToFlowPosition?.({ x, y }) ?? { x: 0, y: 0 };
    onNodeMenuRequested?.(source, pos);
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
        <div className="pointer-events-none absolute left-4 top-4 z-10 rounded-md border border-[#1f2937] bg-[#111827]/90 px-3 py-2 text-[11px] text-[#94a3b8] backdrop-blur">
          <span className="mr-2 inline-block size-1.5 rounded-full bg-[#38bdf8]" />
          从节点底部拖出连线到空白处，选择下游节点类型；点击节点可编辑，按 Delete 删除
        </div>
      )}
      {interactive && (
        <button
          onClick={() => rf?.fitView({ padding: 0.2 })}
          className="absolute bottom-4 left-4 z-10 rounded-md border border-[#1f2937] bg-[#111827]/90 px-2.5 py-1 font-mono text-xs text-[#38bdf8] hover:border-[#38bdf8]/50 hover:bg-[#1e293b]"
        >
          auto layout
        </button>
      )}
    </div>
  );
}
