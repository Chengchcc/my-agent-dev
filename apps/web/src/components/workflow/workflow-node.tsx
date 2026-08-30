"use client";

import type { AskQuestionInput } from "@chengchenccc/agent-contract";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import { Bot, Code2, Flag, type LucideIcon, Play, UserRound } from "lucide-react";
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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

/** Blueprint node card: dark instrument look with a glowing type band. */
export function WorkflowNodeCard({ data, selected }: NodeProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const t = (data as { type?: string }).type ?? "script";
  const status = (data as { status?: string }).status;
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
          left: 0,
          right: 0,
          height: 3,
          ...(status === "failed" ? { background: "#fb7185", boxShadow: "0 0 8px #fb7185" } : {}),
          borderRadius: "12px 12px 0 0",
          background: band,
          boxShadow: `0 0 8px ${band}`,
        }}
      />
      {onDelete && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setConfirmDelete(true);
          }}
          title="Delete node"
          className="absolute -right-2 -top-2 z-10 flex size-5 items-center justify-center rounded-full border border-(--hairline) bg-(--canvas) text-[10px] text-(--err) opacity-0 transition-opacity hover:border-[#fb7185]/60 hover:bg-(--panel2) [.react-flow__node:hover_&]:opacity-100"
        >
          ✕
        </button>
      )}
      <div style={{ padding: "16px 12px 0" }}>
        <div className="flex items-center gap-2">
          {(() => {
            const Icon = typeIcon[t] ?? Bot;
            return <Icon className="size-4" style={{ color: band }} />;
          })()}
          <span style={{ fontSize: 14, fontWeight: 600 }}>
            {String(data.label)}
            {status === "done"
              ? " ✓"
              : status === "active"
                ? " ●"
                : status === "failed"
                  ? " ✗"
                  : ""}
          </span>
        </div>
        <div
          style={{ color: "#94a3b8", fontSize: 12, fontFamily: "var(--font-mono-sf, monospace)" }}
        >
          {t}
        </div>
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
                  上游产出（{arts.length}）— 审批前可展开查看
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
        className="h-2.5! w-8! rounded-full! bg-[#475569]! transition-all! hover:bg-[#38bdf8]! hover:shadow-[0_0_8px_rgba(56,189,248,0.6)]!"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className="h-2.5! w-8! rounded-full! bg-[#475569]! transition-all! hover:bg-[#38bdf8]! hover:shadow-[0_0_8px_rgba(56,189,248,0.6)]!"
      />
      {onDelete && (
        <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete node {String(data.label)}?</AlertDialogTitle>
              <AlertDialogDescription>此操作不可撤销。</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction onClick={() => onDelete()}>删除</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
