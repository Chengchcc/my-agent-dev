"use client";

import { CheckCircle2, GitBranch, Loader2, XCircle } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { useAgentRuns } from "@/features/ops/hooks";
import { api } from "@/lib/api";

export const dynamic = "force-dynamic";

type ExecutionRow = {
  executionId: string;
  workflowId: string;
  triggeredBy?: string | null;
  status: string;
  error?: string;
  createdAt: number;
  terminalAt?: number;
};

function isToday(ts: number | string | undefined) {
  if (ts == null) return false;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

const statusColor: Record<string, string> = {
  success: "text-emerald-400",
  failure: "text-red-400",
  running: "text-amber-400",
  waiting_human: "text-sky-400",
};

export default function WorkTodayPage() {
  const [executions, setExecutions] = useState<ExecutionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const { data: runs } = useAgentRuns();

  useEffect(() => {
    api
      .listWorkflowExecutions()
      .then((res) => {
        setExecutions((res?.executions ?? []) as ExecutionRow[]);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const todayExecs = executions.filter((e) => isToday(e.createdAt));
  const succeeded = todayExecs.filter((e) => e.status === "success").length;
  const failed = todayExecs.filter((e) => e.status === "failure").length;
  const running = todayExecs.filter(
    (e) => e.status === "running" || e.status === "waiting_human",
  ).length;

  const todayRuns = (runs?.runs ?? []).filter((r) => isToday(r.createdAt));
  const runSucceeded = todayRuns.filter((r) => r.status === "completed").length;
  const runFailed = todayRuns.filter(
    (r) => r.status === "failed" || r.status === "aborted" || r.status === "timeout",
  ).length;
  const runRunning = todayRuns.filter(
    (r) => r.status === "running" || r.status === "waiting" || r.status === "commit_failed",
  ).length;
  const totalTokens = todayRuns.reduce(
    (sum, r) => sum + (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0),
    0,
  );

  const today = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <Page>
      <PageHeader title="Work Today" description={today} />
      <PageBody size="reading" className="space-y-8">
        <div>
          <h2 className="text-sm font-medium mb-3">
            Workflow Executions {todayExecs.length > 0 && `(${todayExecs.length})`}
          </h2>
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-(--mute)">
              <Loader2 className="size-3.5 animate-spin" />
              Loading executions…
            </div>
          ) : todayExecs.length === 0 ? (
            <div className="flex items-center gap-2 text-xs text-(--mute)">
              <CheckCircle2 className="size-4" />
              No workflow executions today.
            </div>
          ) : (
            <div className="grid gap-2">
              {todayExecs.slice(0, 12).map((e) => (
                <Link
                  key={e.executionId}
                  href={`/agentic-workflow/${encodeURIComponent(e.workflowId)}/executions/${e.executionId}`}
                  className="flex items-center justify-between gap-3 rounded-lg border border-(--hairline) bg-(--canvas-soft) px-4 py-2.5 hover:border-(--primary) transition-colors"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-medium text-(--ink)">
                      {e.triggeredBy?.startsWith("cron:") && (
                        <span title={e.triggeredBy} className="shrink-0 text-[10px]">
                          ⏰
                        </span>
                      )}
                      <GitBranch className="size-3.5 shrink-0 text-(--mute)" />
                      <span className="truncate">{e.workflowId}</span>
                    </div>
                    <div className="truncate font-mono text-[10px] text-(--mute)">
                      {e.executionId}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {e.status === "failure" && <XCircle className="size-3.5 text-(--err)" />}
                    <span
                      className={`text-xs tabular-nums ${statusColor[e.status] ?? "text-(--mute)"}`}
                    >
                      {e.status === "waiting_human" ? "waiting human" : e.status}
                    </span>
                    {e.status === "running" && (
                      <Loader2 className="size-3.5 animate-spin text-(--primary)" />
                    )}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        <div>
          <h2 className="text-sm font-medium mb-3">Today&apos;s Runs</h2>
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-lg border border-(--hairline) bg-(--canvas-soft) p-4">
              <div className="text-2xl font-semibold text-emerald-400 tabular-nums">
                {runSucceeded}
              </div>
              <div className="text-xs text-(--mute)">Succeeded</div>
            </div>
            <div className="rounded-lg border border-(--hairline) bg-(--canvas-soft) p-4">
              <div className="text-2xl font-semibold text-red-400 tabular-nums">{runFailed}</div>
              <div className="text-xs text-(--mute)">Failed</div>
            </div>
            <div className="rounded-lg border border-(--hairline) bg-(--canvas-soft) p-4">
              <div className="text-2xl font-semibold text-amber-400 tabular-nums">{runRunning}</div>
              <div className="text-xs text-(--mute)">Running</div>
            </div>
          </div>
          {succeeded + failed + running > 0 && (
            <div className="mt-3 rounded-lg border border-(--hairline) bg-(--canvas-soft) p-4">
              <div className="flex items-center gap-2 text-lg font-semibold text-(--ink) tabular-nums">
                <Badge variant="outline">{succeeded}</Badge>
                <Badge variant="outline">{failed}</Badge>
                <Badge variant="outline">{running}</Badge>
                <span className="ml-auto text-2xl">{totalTokens.toLocaleString()}</span>
              </div>
              <div className="mt-1 text-xs text-(--mute)">
                Workflow executions today: {succeeded} success / {failed} failed / {running} running
              </div>
            </div>
          )}
        </div>
      </PageBody>
    </Page>
  );
}
