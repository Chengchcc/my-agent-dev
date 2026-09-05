import { topoSort } from "../graph.js";
import type { WorkflowDefinition } from "../types.js";

export interface PositionedNode {
  id: string;
  x: number;
  y: number;
  layer: number;
}

/** Left-right layout (Obsidian Live DAG): layer = column (x grows right),
 *  index-in-layer = row (y). Connectors flow left → right like the design
 *  (`01 → 02 → 03 → 04`). */
const LAYER_GAP_X = 300;
const NODE_GAP_Y = 170;

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
    x: (layer.get(id) ?? 0) * LAYER_GAP_X,
    y: (indexInLayer.get(id) ?? 0) * NODE_GAP_Y,
  }));
}
