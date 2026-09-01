"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export interface AgentRunRow {
  runId: string;
  status: string;
  agentId: string;
  model: string;
  createdAt: number;
  terminalAt: number | null;
  usage: { inputTokens?: number; outputTokens?: number } | null;
  error?: string | null;
}

// 400-family colors stay readable on both light and dark surfaces; badges
// get a border so status is never communicated by color alone.
const STATUS_STYLES: Record<string, string> = {
  running: "bg-blue-500/10 text-blue-400 border-blue-500/30",
  waiting: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  commit_failed: "bg-orange-500/10 text-orange-400 border-orange-500/30",
  completed: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
  failed: "bg-red-500/10 text-red-400 border-red-500/30",
  aborted: "bg-zinc-500/10 text-zinc-400 border-zinc-500/30",
  timeout: "bg-zinc-500/10 text-zinc-400 border-zinc-500/30",
};

function tokens(r: AgentRunRow): string {
  return r.usage ? `${(r.usage.inputTokens ?? 0) + (r.usage.outputTokens ?? 0)} tok` : "—";
}

function startedAt(r: AgentRunRow): string {
  return new Date(r.createdAt).toLocaleString();
}

function canCancel(status: string): boolean {
  return ["running", "waiting", "commit_failed"].includes(status);
}

export function AgentRunsTable({
  runs,
  onCancel,
}: {
  runs: AgentRunRow[];
  onCancel: (runId: string) => void;
}) {
  if (runs.length === 0) {
    return <p className="text-sm text-(--mute)">No Agent Runs yet.</p>;
  }
  const hasErrors = runs.some((r) => r.error);

  return (
    <>
      {/* Mobile: card list (no horizontal scroll of a desktop table). */}
      <div className="space-y-2 md:hidden">
        {runs.map((r) => (
          <div key={r.runId} className="rounded-lg border border-(--hairline) bg-(--canvas) p-3">
            <div className="flex items-center justify-between gap-2">
              <Link href={`/system/runs/${r.runId}`} className="font-mono text-xs underline">
                {r.runId.slice(0, 12)}
              </Link>
              <Badge className={STATUS_STYLES[r.status] ?? ""}>{r.status}</Badge>
            </div>
            <p className="mt-1.5 text-sm text-(--ink) truncate">{r.model}</p>
            <p className="text-xs text-(--mute)">
              {r.agentId || "default"} · {startedAt(r)}
            </p>
            {r.error && (
              <p className="mt-1 text-xs text-red-400 line-clamp-2" title={r.error}>
                {r.error}
              </p>
            )}
            <div className="mt-1 flex items-center justify-between">
              <span className="text-xs text-(--mute)">{tokens(r)}</span>
              {canCancel(r.status) && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs text-destructive"
                  onClick={() => onCancel(r.runId)}
                >
                  Cancel
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Desktop: full table. */}
      <div className="hidden overflow-x-auto rounded-lg border border-(--hairline) md:block">
        <table className="w-full text-sm table-fixed">
          <thead className="bg-(--canvas-soft) text-left text-xs text-(--mute)">
            <tr>
              <th className="p-2 w-[120px]">Run</th>
              <th className="p-2 w-[100px]">Status</th>
              <th className="p-2 w-[100px]">Agent</th>
              <th className="p-2">Model</th>
              <th className="p-2 w-[160px]">Started</th>
              <th className="p-2 w-[80px] text-right">Usage</th>
              {hasErrors && <th className="p-2">Error</th>}
              <th className="p-2 w-[80px]" />
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.runId} className="border-t border-(--hairline)">
                <td className="p-2">
                  <Link href={`/system/runs/${r.runId}`} className="underline">
                    {r.runId.slice(0, 12)}
                  </Link>
                </td>
                <td className="p-2">
                  <Badge className={STATUS_STYLES[r.status] ?? ""}>{r.status}</Badge>
                </td>
                <td className="p-2">{r.agentId}</td>
                <td className="p-2 max-w-0 truncate" title={r.model}>
                  {r.model}
                </td>
                <td className="p-2 text-xs text-(--mute)">{startedAt(r)}</td>
                <td className="p-2 text-xs text-(--mute)">{tokens(r)}</td>
                {hasErrors && (
                  <td className="p-2 text-xs text-red-400 max-w-0 truncate" title={r.error ?? ""}>
                    {r.error ?? "—"}
                  </td>
                )}
                <td className="p-2 text-right">
                  {canCancel(r.status) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs text-destructive"
                      onClick={() => onCancel(r.runId)}
                    >
                      Cancel
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
