"use client";

import { Background, type Edge, type Node, ReactFlow } from "@xyflow/react";
import { useMemo } from "react";
import "@xyflow/react/dist/style.css";
import type { EditorGraph } from "@chengchenccc/workflow";

export function WorkflowCanvas({
  graph,
  onSelect,
}: {
  graph: EditorGraph;
  onSelect: (id: string) => void;
}) {
  const nodes: Node[] = useMemo(
    () =>
      graph.nodes.map((n) => ({
        id: n.id,
        position: { x: n.x, y: n.y },
        data: { label: n.label, type: n.type, layer: n.layer },
      })),
    [graph],
  );
  const edges: Edge[] = useMemo(
    () => graph.edges.map((e) => ({ id: e.id, source: e.from, target: e.to, label: e.label })),
    [graph],
  );
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodesDraggable={false}
      nodesConnectable={false}
      fitView
      onNodeClick={(_, node) => onSelect(node.id)}
    >
      <Background />
    </ReactFlow>
  );
}
