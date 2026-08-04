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
}

const STATUS_STYLES: Record<string, string> = {
  running: "bg-blue-500/10 text-blue-600",
  waiting: "bg-amber-500/10 text-amber-600",
  commit_failed: "bg-orange-500/10 text-orange-600",
  completed: "bg-green-500/10 text-green-600",
  failed: "bg-red-500/10 text-red-600",
  aborted: "bg-zinc-500/10 text-zinc-600",
  timeout: "bg-zinc-500/10 text-zinc-600",
};

export function AgentRunsTable({
  runs,
  onCancel,
}: {
  runs: AgentRunRow[];
  onCancel: (runId: string) => void;
}) {
  if (runs.length === 0) {
    return <p className="text-sm text-[var(--mute)]">No Agent Runs yet.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--hairline)]">
      <table className="w-full text-sm">
        <thead className="bg-[var(--panel)] text-left text-xs text-[var(--mute)]">
          <tr>
            <th className="p-2">Run</th>
            <th className="p-2">Status</th>
            <th className="p-2">Agent</th>
            <th className="p-2">Model</th>
            <th className="p-2">Started</th>
            <th className="p-2">Usage</th>
            <th className="p-2" />
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.runId} className="border-t border-[var(--hairline)]">
              <td className="p-2">
                <Link href={`/system/runs/${r.runId}`} className="underline">
                  {r.runId.slice(0, 12)}
                </Link>
              </td>
              <td className="p-2">
                <Badge className={STATUS_STYLES[r.status] ?? ""}>{r.status}</Badge>
              </td>
              <td className="p-2">{r.agentId}</td>
              <td className="p-2">{r.model}</td>
              <td className="p-2 text-xs text-[var(--mute)]">
                {new Date(r.createdAt).toLocaleString()}
              </td>
              <td className="p-2 text-xs text-[var(--mute)]">
                {r.usage ? `${(r.usage.inputTokens ?? 0) + (r.usage.outputTokens ?? 0)} tok` : "—"}
              </td>
              <td className="p-2 text-right">
                {["running", "waiting", "commit_failed"].includes(r.status) && (
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
  );
}
