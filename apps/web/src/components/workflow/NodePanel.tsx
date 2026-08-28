"use client";

import type { WorkflowNode } from "@chengchenccc/workflow";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { NODE_TYPES, type NodeTypeOption } from "./NodeMenuPopover";

/** Persistent left node palette (Dify-style): search + category list. */
export function NodePanel({ onAdd }: { onAdd: (node: WorkflowNode) => void }) {
  const [q, setQ] = useState("");
  const filtered = useMemo(
    () => NODE_TYPES.filter((n) => n.title.toLowerCase().includes(q.toLowerCase())),
    [q],
  );
  return (
    <div className="flex w-52 shrink-0 flex-col border-r border-[var(--hairline)] bg-[var(--panel)]/70">
      <div className="border-b border-[var(--hairline)] p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-[var(--mute)]" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索节点…"
            className="h-8 w-full rounded-md border border-[var(--hairline)] bg-[var(--canvas)] pl-7 pr-2 text-xs text-[var(--ink)] outline-none placeholder:text-[var(--faint)] focus:border-[#38bdf8]/50"
          />
        </div>
      </div>
      <div className="flex-1 overflow-auto p-2">
        {filtered.map((opt: NodeTypeOption) => (
          <NodeRow key={opt.type} opt={opt} onAdd={onAdd} />
        ))}
        {filtered.length === 0 && (
          <div className="px-2 py-6 text-center text-xs text-[var(--faint)]">无匹配节点</div>
        )}
      </div>
    </div>
  );
}

function NodeRow({ opt, onAdd }: { opt: NodeTypeOption; onAdd: (node: WorkflowNode) => void }) {
  const Icon = opt.icon;
  return (
    <button
      onClick={() => onAdd(opt.make())}
      className="group mb-1 flex w-full items-center gap-2 rounded-lg border border-[var(--hairline)] bg-[var(--panel)] px-2 py-2 text-left transition-all hover:-translate-y-0.5 hover:border-[var(--primary)]/40 hover:shadow-[0_0_12px_rgba(245,158,11,0.1)]"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-[var(--hairline)] bg-[var(--canvas)] text-[var(--info)]">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-xs font-medium text-[var(--ink)] group-hover:text-[var(--primary)]">
          {opt.title}
        </span>
        <span className="block truncate text-[10px] text-[var(--mute)]">{opt.description}</span>
      </span>
    </button>
  );
}
