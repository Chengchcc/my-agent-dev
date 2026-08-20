"use client";

import { Badge } from "@/components/ui/badge";

const STEP_ORDER = ["fixing", "verifying", "awaiting_review", "resolved", "inbox"] as const;
const STEP_BADGE: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  fixing: "outline",
  verifying: "secondary",
  awaiting_review: "default",
  resolved: "outline",
  inbox: "outline",
};

interface LoopBoardItem {
  id: string;
  source: string;
  summary: string;
  step: string;
  attempt: number;
  priority: number;
  taskClass?: string;
  defer?: { reason: string } | null;
}

interface LoopBoardProps {
  items: LoopBoardItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function LoopBoard({ items, selectedId, onSelect }: LoopBoardProps) {
  const grouped: Record<string, LoopBoardItem[]> = {};
  for (const it of items) {
    if (!grouped[it.step]) grouped[it.step] = [];
    grouped[it.step]!.push(it);
  }

  return (
    <div className="flex gap-3 overflow-x-auto pb-4 h-full">
      {STEP_ORDER.map((step) => {
        const colItems = grouped[step] ?? [];
        return (
          <div key={step} className="shrink-0 w-64 flex flex-col">
            <div className="flex items-center gap-2 p-2 mb-1">
              <Badge variant={STEP_BADGE[step]} className="text-[10px]">
                {step}
              </Badge>
              <span className="text-xs text-(--mute)">{colItems.length}</span>
            </div>
            <div className="flex-1 space-y-2 overflow-y-auto">
              {colItems.map((item) => (
                <button
                  key={item.id}
                  onClick={() => onSelect(item.id)}
                  className={`w-full text-left rounded-md border p-3 text-sm transition-colors ${
                    selectedId === item.id
                      ? "border-(--primary) bg-(--primary)/5 ring-1 ring-(--primary)/30"
                      : "border-(--hairline) hover:border-(--primary)/50"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="truncate flex-1 font-medium">{item.summary}</span>
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-(--mute)">
                    <span className="font-mono">{item.source}</span>
                    <span>· att {item.attempt}</span>
                    {item.priority > 0 && (
                      <span
                        className={
                          item.priority >= 3
                            ? "text-red-600"
                            : item.priority >= 2
                              ? "text-orange-600"
                              : ""
                        }
                      >
                        p{item.priority}
                      </span>
                    )}
                    {item.taskClass && (
                      <span className="rounded bg-(--canvas-soft) px-1 py-px uppercase tracking-wider text-(--faint)">
                        {item.taskClass}
                      </span>
                    )}
                    {item.defer && (
                      <span
                        className="rounded bg-amber-500/10 px-1 py-px text-amber-700"
                        title={item.defer.reason}
                      >
                        ⏸ deferred
                      </span>
                    )}
                  </div>
                </button>
              ))}
              {colItems.length === 0 && (
                <div className="text-center py-4">
                  <span className="text-[10px] text-(--mute)">-</span>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
