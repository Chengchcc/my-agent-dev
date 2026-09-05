"use client";

import type { AskQuestionInput } from "@chengchenccc/agent-contract";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import { Bot, Code2, Flag, type LucideIcon, Play, UserRound } from "lucide-react";
import { AskQuestionCard } from "./AskQuestionCard";

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

/** Node execution status → { color, label } for the status pill. */
const STATUS_STYLE: Record<string, { color: string; label: string }> = {
  done: { color: "var(--ok)", label: "\u2713 done" },
  active: { color: "var(--primary)", label: "\u25cf running" },
  failed: { color: "var(--err)", label: "\u2717 failed" },
};

/** Blueprint node card: dark instrument look with a glowing type band. */
export function WorkflowNodeCard({ data, selected }: NodeProps) {
  const t = (data as { type?: string }).type ?? "script";
  const status = (data as { status?: string }).status;
  const summaryProp = (data as { summary?: string }).summary;
  const metaProp = (data as { meta?: string }).meta;
  const askRendered = t === "human" && Boolean((data as { askQuestion?: unknown }).askQuestion);
  const onDelete = (data as { onDelete?: () => void }).onDelete;
  const band = typeColor[t] ?? "var(--wf-info)";
  return (
    <div
      style={{
        width: 220,
        height:
          t === "human" && (data as { askQuestion?: AskQuestionInput }).askQuestion ? "auto" : 100,
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
      <div className="pl-3.5 pr-3 pt-3">
        <div className="flex items-center justify-between font-mono text-[9px] font-semibold uppercase tracking-kicker text-(--mute)">
          <span>{t}</span>
          {status && STATUS_STYLE[status] && (
            <span style={{ color: STATUS_STYLE[status].color }}>{STATUS_STYLE[status].label}</span>
          )}
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          {(() => {
            const Icon = typeIcon[t] ?? Bot;
            return <Icon className="size-4" style={{ color: band }} />;
          })()}
          <span className="truncate font-display text-sm font-semibold">{String(data.label)}</span>
        </div>
        {!(askRendered && summaryProp) && (
          <div className="truncate font-mono text-[11px] text-(--mute)">
            {summaryProp || `${t} node`}
          </div>
        )}
      </div>
      {t === "human" && (data as { askQuestion?: AskQuestionInput }).askQuestion && (
        <div className="pointer-events-auto px-3 pb-3">
          {(() => {
            const arts = (
              data as { upstreamArtifacts?: Array<{ url: string; from: string; content?: string }> }
            ).upstreamArtifacts;
            if (!arts?.length) return null;
            return (
              <details className="mb-2 rounded-md border border-(--hairline) bg-(--canvas)/60 p-2">
                <summary className="cursor-pointer text-[10px] text-(--mute)">
                  Upstream outputs ({arts.length}) - expandable before approval
                </summary>
                {arts.map((a) => (
                  <div
                    key={a.url}
                    className="mt-1 border-t border-(--hairline) pt-1 first:border-t-0 first:pt-0"
                  >
                    <div className="truncate font-mono text-[10px] text-(--info)" title={a.url}>
                      {a.from} → {a.url}
                    </div>
                    {a.content !== undefined && (
                      <pre className="mt-0.5 max-h-32 overflow-auto text-[10px] text-(--mute)">
                        {a.content.slice(0, 2000)}
                      </pre>
                    )}
                  </div>
                ))}
              </details>
            );
          })()}
          <AskQuestionCard
            input={(data as { askQuestion: AskQuestionInput }).askQuestion}
            onSubmit={async (result) => {
              await (
                data as { onSubmitHuman?: (answer: Record<string, unknown>) => Promise<void> }
              ).onSubmitHuman?.({ answers: result.answers } as Record<string, unknown>);
            }}
          />
        </div>
      )}
      {metaProp && t !== "human" && (
        <div
          className="absolute inset-x-2 bottom-2 flex items-center justify-between rounded bg-(--canvas) px-2 py-1 font-mono text-[9px]"
          style={{ pointerEvents: "none" }}
        >
          <span className="truncate text-(--mute)">{metaProp}</span>
          <span className="shrink-0 text-(--faint)">{t}</span>
        </div>
      )}
      <span
        className="pointer-events-none absolute inset-x-0 top-0 z-0 h-full"
        style={{
          background: `linear-gradient(180deg, ${band}22, transparent 40%)`,
          opacity: 0,
          transition: "opacity 0.2s",
        }}
      />
      <Handle
        type="target"
        position={Position.Top}
        className="h-2.5! w-8! rounded-full! bg-(--faint)! transition-all! hover:bg-(--primary)! hover:shadow-[0_0_8px_var(--primary)]!"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className="h-2.5! w-8! rounded-full! bg-(--faint)! transition-all! hover:bg-(--primary)! hover:shadow-[0_0_8px_var(--primary)]!"
      />
    </div>
  );
}
