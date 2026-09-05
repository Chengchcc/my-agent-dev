"use client";

import { Maximize, ZoomIn, ZoomOut } from "lucide-react";
import { useState } from "react";

type ZoomApi = {
  zoomIn?: () => void;
  zoomOut?: () => void;
  fitView?: (opts?: { padding?: number }) => void;
  setZoom?: (z: number) => void;
  getZoom?: () => number;
};

/** Top DAG orchestrator bar: zoom controls + `Stream Active` toggle on the
 *  left, and the `DAG Nodes / Acyclic Depth / Deterministic Validated` stats
 *  on the right (Obsidian Live DAG anatomy). */
export function DagStatsBar({
  nodeCount,
  depth,
  validated,
  streaming,
  onToggleStream,
  zoom,
}: {
  nodeCount: number;
  depth: number;
  validated: boolean;
  streaming: boolean;
  onToggleStream?: () => void;
  zoom?: ZoomApi;
}) {
  const [level, setLevel] = useState(100);
  return (
    <div className="flex shrink-0 items-center justify-between border-b border-(--hairline) bg-(--canvas-soft) px-4 py-2">
      {/* Zoom controls */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => zoom?.zoomOut?.()}
          className="rounded p-1 text-(--mute) hover:bg-(--panel2) hover:text-(--ink)"
          aria-label="Zoom out"
        >
          <ZoomOut size={14} />
        </button>
        <button
          type="button"
          onClick={() => zoom?.zoomIn?.()}
          className="rounded p-1 text-(--mute) hover:bg-(--panel2) hover:text-(--ink)"
          aria-label="Zoom in"
        >
          <ZoomIn size={14} />
        </button>
        <button
          type="button"
          onClick={() => {
            zoom?.fitView?.({ padding: 0.2 });
            setLevel(100);
          }}
          className="rounded p-1 text-(--mute) hover:bg-(--panel2) hover:text-(--ink)"
          aria-label="Fit view"
        >
          <Maximize size={14} />
        </button>
        <span className="ml-1 font-mono text-[10px] text-(--faint) tabular-nums">{level}%</span>
        <span className="ml-2 h-4 w-px bg-(--hairline)" />
        {onToggleStream && (
          <button
            type="button"
            onClick={onToggleStream}
            className={`flex items-center gap-1.5 rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-kicker ${
              streaming
                ? "bg-(--ok)/10 text-(--ok)"
                : "bg-(--panel2) text-(--mute) hover:text-(--ink)"
            }`}
          >
            <span
              className={`size-1.5 rounded-full ${streaming ? "bg-(--ok) animate-pulse" : "bg-(--faint)"}`}
            />
            {streaming ? "stream active" : "stream paused"}
          </button>
        )}
      </div>

      {/* DAG stats */}
      <div className="flex items-center gap-4 font-mono text-[10px] uppercase tracking-kicker text-(--mute)">
        <span>
          DAG Nodes: <span className="text-(--ink-strong)">{nodeCount}</span>
        </span>
        <span>
          Acyclic Depth: <span className="text-(--ink-strong)">{depth}</span>
        </span>
        <span className="flex items-center gap-1">
          Deterministic{" "}
          <span className={validated ? "text-(--ok)" : "text-(--err)"}>
            {validated ? "Validated" : "Not validated"}
          </span>
        </span>
      </div>
    </div>
  );
}
