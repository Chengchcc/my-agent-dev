"use client";

import { Background, BackgroundVariant, type Edge, type Node, ReactFlow } from "@xyflow/react";
import { useMemo } from "react";
import "@xyflow/react/dist/style.css";
import type { EditorGraph } from "@chengchenccc/workflow";
import { WorkflowNodeCard } from "./workflow-node";

export type NodeStatus = "done" | "active" | "idle";

export function WorkflowCanvas({
  graph,
  onSelect,
  nodeStatus,
  litEdges,
  interactive = false,
  onConnect,
  onNodeDelete,
  onEdgeSelect,
}: {
  graph: EditorGraph;
  onSelect?: (id: string) => void;
  nodeStatus?: Record<string, NodeStatus>;
  litEdges?: Set<string>;
  interactive?: boolean;
  onConnect?: (from: string, to: string) => void;
  onNodeDelete?: (id: string) => void;
  onEdgeSelect?: (edgeIndex: number) => void;
}) {
  const nodeTypes = { default: WorkflowNodeCard };
  const nodes: Node[] = useMemo(
    () =>
      graph.nodes.map((n) => {
        const status = nodeStatus?.[n.id] ?? "idle";
        return {
          id: n.id,
          type: "default",
          position: { x: n.x, y: n.y },
          data: { label: n.label, type: n.type, layer: n.layer, status },
          opacity: status === "idle" && nodeStatus ? 0.45 : 1,
        };
      }),
    [graph, nodeStatus],
  );
  const edges: Edge[] = useMemo(
    () =>
      graph.edges.map((e) => {
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
      }),
    [graph, litEdges],
  );
  return (
    <div style={{ background: "var(--wf-canvas-bg)", height: "100%", width: "100%" }}>
      <ReactFlow
        nodeTypes={nodeTypes}
        nodes={nodes}
        edges={edges}
        nodesDraggable={interactive}
        nodesConnectable={interactive}
        fitView
        onNodeClick={onSelect ? (_, node) => onSelect(node.id) : undefined}
        onConnect={onConnect ? (c) => onConnect(c.source!, c.target!) : undefined}
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
      >
        <Background variant={BackgroundVariant.Lines} gap={24} size={1} color="var(--wf-grid)" />
      </ReactFlow>
    </div>
  );
}
