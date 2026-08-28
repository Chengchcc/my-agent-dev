"use client";

import { Handle, type NodeProps, Position } from "@xyflow/react";

const typeColor: Record<string, string> = {
  start: "var(--wf-color-start)",
  end: "var(--wf-color-end)",
  agent: "var(--wf-color-agent)",
  script: "var(--wf-color-script)",
  human: "var(--wf-color-human)",
};

/** Blueprint node card: dark instrument look with a glowing type band. */
export function WorkflowNodeCard({ data, selected }: NodeProps) {
  const t = (data as { type?: string }).type ?? "script";
  const status = (data as { status?: string }).status;
  const band = typeColor[t] ?? "var(--wf-info)";
  return (
    <div
      style={{
        width: 260,
        height: 100,
        borderRadius: 12,
        position: "relative",
        background:
          "linear-gradient(180deg, rgba(255,255,255,0.04), transparent), var(--wf-node-bg)",
        border: `1px solid ${selected ? "var(--wf-accent)" : "var(--wf-node-border)"}`,
        boxShadow: selected
          ? "0 0 0 2px var(--wf-accent), 0 0 24px rgba(245,158,11,0.35)"
          : "0 4px 16px rgba(0,0,0,0.4)",
        color: "var(--wf-node-text)",
        animation: "wf-pop 0.25s ease-out both",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 3,
          borderRadius: "12px 12px 0 0",
          background: band,
          boxShadow: `0 0 8px ${band}`,
        }}
      />
      <div style={{ padding: "16px 12px 0" }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>
          {String(data.label)}
          {status === "done" ? " ✓" : status === "active" ? " ●" : ""}
        </div>
        <div
          style={{ color: "#94a3b8", fontSize: 12, fontFamily: "var(--font-mono-sf, monospace)" }}
        >
          {t}
        </div>
      </div>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
