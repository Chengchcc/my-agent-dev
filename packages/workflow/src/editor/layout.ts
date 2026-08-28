import { topoSort } from "../graph.js";
import type { WorkflowDefinition } from "../types.js";

export interface PositionedNode {
  id: string;
  x: number;
  y: number;
  layer: number;
}

/** Top-bottom layout: layer = row (y grows downward), index-in-layer = column. */
const LAYER_GAP_Y = 150;
const NODE_GAP_X = 260;

/** Deterministic layered layout: longest-path layer + per-layer stacking. */
export function layeredLayout(def: WorkflowDefinition): PositionedNode[] {
  const order = topoSort(def);
  const layer = new Map<string, number>();
  for (const id of order) layer.set(id, 0);
  for (const id of order) {
    const cur = layer.get(id) ?? 0;
    for (const e of def.edges) {
      if (e.from === id) layer.set(e.to, Math.max(layer.get(e.to) ?? 0, cur + 1));
    }
  }
  const indexInLayer = new Map<string, number>();
  const counts = new Map<number, number>();
  for (const id of order) {
    const l = layer.get(id) ?? 0;
    const idx = counts.get(l) ?? 0;
    indexInLayer.set(id, idx);
    counts.set(l, idx + 1);
  }
  return order.map((id) => ({
    id,
    layer: layer.get(id) ?? 0,
    x: (indexInLayer.get(id) ?? 0) * NODE_GAP_X,
    y: (layer.get(id) ?? 0) * LAYER_GAP_Y,
  }));
}
