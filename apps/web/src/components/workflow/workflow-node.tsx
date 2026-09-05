"use client";

import { Handle, type NodeProps, Position } from "@xyflow/react";
import { Bot, Code2, Flag, type LucideIcon, Play, UserRound } from "lucide-react";

const typeIcon: Record<string, LucideIcon> = {
  start: Play,
  end: Flag,
  agent: Bot,
  script: Code2,
  human: UserRound,
};

const typeColor: Record<string, string> = {
  start: "var(--wf-color-start)",
  end: "var(--wf-color-end)",
  agent: "var(--wf-color-agent)",
  script: "var(--wf-color-script)",
  human: "var(--wf-color-human)",
};

/** Node execution status → high-contrast label pill (Obsidian design:
 *  `RUNNING`/`PASSED`/`● done`/`⏱ 200 OK` style). */
const STATUS_STYLE: Record<string, { className: string; label: string }> = {
  done: {
    className: "border-(--ok)/30 bg-(--ok)/10 text-(--ok)",
    label: "✓ done",
  },
  active: {
    className: "border-(--primary)/30 bg-(--primary)/10 text-(--primary)",
    label: "● running",
  },
  failed: {
    className: "border-(--err)/30 bg-(--err)/10 text-(--err)",
    label: "✗ failed",
  },
};

/** Blueprint node card (Obsidian Live DAG anatomy): numbered title row with a
 *  high-contrast status pill, icon + label + subtitle, and a footer meta row. */
export function WorkflowNodeCard({ data, selected }: NodeProps) {
  const t = (data as { type?: string }).type ?? "script";
  const status = (data as { status?: string }).status as string | undefined;
  const summaryProp = (data as { summary?: string }).summary;
  const metaProp = (data as { meta?: string }).meta;
  const seq = (data as { seq?: number }).seq;
  const onDelete = (data as { onDelete?: () => void }).onDelete;
  const band = typeColor[t] ?? "var(--wf-info)";
  const pill = status ? STATUS_STYLE[status] : undefined;

  return (
    <div
      style={{
        width: 240,
        minHeight: 108,
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
      {/* Type band */}
      <div
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: 0,
          width: 3,
          background: status === "failed" ? "var(--err)" : band,
          boxShadow: `0 0 8px ${status === "failed" ? "var(--err)" : band}`,
          borderRadius: "12px 0 0 12px",
        }}
      />
      {onDelete && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title="Delete node"
          className="absolute -right-2 -top-2 z-10 flex size-5 items-center justify-center rounded-full border border-(--hairline) bg-(--canvas) text-[10px] text-(--err) opacity-0 transition-opacity hover:border-(--err) hover:bg-(--panel2) [.react-flow__node:hover_&]:opacity-100"
        >
          ✕
        </button>
      )}
      <div className="pl-3.5 pr-3 pt-2.5">
        {/* Title row: `01 - TYPE` + status pill */}
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-kicker text-(--mute)">
            {seq != null && (
              <span className="shrink-0 text-(--faint)">{String(seq).padStart(2, "0")}</span>
            )}
            <span className="truncate">- {t}</span>
          </span>
          {pill && (
            <span
              className={`shrink-0 rounded border px-1.5 py-0.5 font-label-caps text-label-caps font-bold uppercase ${pill.className}`}
            >
              {pill.label}
            </span>
          )}
        </div>
        {/* Label + icon */}
        <div className="mt-1.5 flex items-center gap-2">
          {(() => {
            const Icon = typeIcon[t] ?? Bot;
            return <Icon className="size-4 shrink-0" style={{ color: band }} />;
          })()}
          <span className="truncate font-display text-sm font-semibold">{String(data.label)}</span>
        </div>
        {/* Subtitle */}
        <div className="mt-0.5 truncate font-mono text-[11px] text-(--mute)">
          {summaryProp || `${t} node`}
        </div>
      </div>
      {/* Human gate: compact node only. The ask form / approval lives OUTSIDE
          the node — editor uses the side Properties inspector (HumanFormEditor),
          execution uses the bottom run console. Never inline in the 240px card. */}
      {t === "human" && (
        <div className="pointer-events-auto px-3 pb-3">
          <div className="rounded-md border border-(--hairline) bg-(--canvas)/50 px-2.5 py-2">
            <div className="flex items-center gap-1.5">
              <UserRound className="size-3.5 shrink-0 text-(--accent-violet)" />
              <span className="truncate font-mono text-[10px] text-(--mute)">
                {status === "active"
                  ? "awaiting answer"
                  : status === "done"
                    ? "answered"
                    : "human gate"}
              </span>
            </div>
            {(data as { summary?: string }).summary && (
              <p className="mt-1 line-clamp-2 font-mono text-[10px] leading-snug text-(--body)">
                {(data as { summary: string }).summary}
              </p>
            )}
          </div>
        </div>
      )}
      {/* Footer meta row */}
      {metaProp && t !== "human" && (
        <div
          className="absolute inset-x-2 bottom-2 flex items-center justify-between rounded bg-(--canvas) px-2 py-1 font-mono text-[9px]"
          style={{ pointerEvents: "none" }}
        >
          <span className="truncate text-(--mute)">{metaProp}</span>
          <span className="shrink-0 text-(--faint)">{t}</span>
        </div>
      )}
      <Handle type="target" position={Position.Left} style={{ background: band }} />
      <Handle type="source" position={Position.Right} style={{ background: band }} />
    </div>
  );
}
