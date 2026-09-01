"use client";

import { CheckCircle2, GitBranch, Loader2, XCircle } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { useAgentRuns, useTelemetrySummary } from "@/features/ops/hooks";
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

export default function TodayPage() {
  const [executions, setExecutions] = useState<ExecutionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const { data: runs } = useAgentRuns();
  const telemetry = useTelemetrySummary();
  const maxHourlyCost = Math.max(0, ...(telemetry.data?.costByHour.map((h) => h.costUsd) ?? [0]));

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
  const waitingHuman = executions.filter((e) => e.status === "waiting_human");
  const succeeded = todayExecs.filter((e) => e.status === "success").length;
  const failed = todayExecs.filter((e) => e.status === "failure").length;
  const running = todayExecs.filter(
    (e) => e.status === "running" || e.status === "waiting_human",
  ).length;

  const todayRuns = (runs?.runs ?? []).filter((r) => isToday(r.createdAt));
  const activeRuns = (runs?.runs ?? []).filter((r) =>
    ["running", "waiting", "commit_failed"].includes(r.status),
  );
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
      <PageHeader
        breadcrumb={[{ label: "Work", href: "/today" }, { label: "Today" }]}
        title="Today"
        description={today}
      />
      <PageBody size="reading" className="space-y-8">
        {waitingHuman.length > 0 && (
          <div>
            <h2 className="text-sm font-medium mb-3">
              Needs you {waitingHuman.length > 0 && `(${waitingHuman.length})`}
            </h2>
            <div className="grid gap-2">
              {waitingHuman.slice(0, 8).map((e) => (
                <Link
                  key={e.executionId}
                  href={`/workflows/${encodeURIComponent(e.workflowId)}/executions/${e.executionId}`}
                  className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-2.5 hover:border-amber-400 transition-colors"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-(--ink)">{e.workflowId}</div>
                    <div className="truncate font-mono text-[10px] text-(--mute)">
                      {e.executionId}
                    </div>
                  </div>
                  <span className="shrink-0 text-xs text-amber-500">waiting human</span>
                </Link>
              ))}
            </div>
          </div>
        )}
        {activeRuns.length > 0 && (
          <div>
            <h2 className="text-sm font-medium mb-3">Running now</h2>
            <div className="grid gap-2">
              {activeRuns.slice(0, 8).map((r) => (
                <Link
                  key={r.runId}
                  href={`/system/runs/${r.runId}`}
                  className="flex items-center justify-between gap-3 rounded-lg border border-(--hairline) bg-(--canvas-soft) px-4 py-2.5 hover:border-(--primary) transition-colors"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-(--ink)">
                      {r.agentId} · {r.model.modelId}
                    </div>
                    <div className="truncate font-mono text-[10px] text-(--mute)">
                      {r.runId.slice(0, 12)}
                    </div>
                  </div>
                  <span className="shrink-0 text-xs text-amber-400">{r.status}</span>
                </Link>
              ))}
            </div>
          </div>
        )}
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
              No workflow executions today.{" "}
              <Link href="/workflows" className="text-(--info) hover:underline">
                Create a workflow
              </Link>{" "}
              to automate recurring work.
            </div>
          ) : (
            <div className="grid gap-2">
              {todayExecs.slice(0, 12).map((e) => (
                <Link
                  key={e.executionId}
                  href={`/workflows/${encodeURIComponent(e.workflowId)}/executions/${e.executionId}`}
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
          {runSucceeded + runFailed + runRunning === 0 ? (
            <p className="text-xs text-(--mute)">No runs today.</p>
          ) : (
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
                <div className="text-2xl font-semibold text-amber-400 tabular-nums">
                  {runRunning}
                </div>
                <div className="text-xs text-(--mute)">Running</div>
              </div>
            </div>
          )}
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
        {telemetry.data && telemetry.data.costByHour.length > 0 && (
          <div>
            <h2 className="text-sm font-medium mb-3">Cost burn (24h)</h2>
            <div className="flex h-16 items-end gap-1 rounded-lg border border-(--hairline) bg-(--canvas-soft) p-3">
              {telemetry.data.costByHour.map((h) => (
                <div
                  key={h.hour}
                  className="flex-1 rounded-t bg-amber-400/60"
                  style={{
                    height: `${maxHourlyCost > 0 ? Math.max(2, (h.costUsd / maxHourlyCost) * 100) : 2}%`,
                  }}
                  title={`${new Date(h.hour).toLocaleTimeString()} · $${h.costUsd.toFixed(4)} · ${h.tokens} tok`}
                />
              ))}
            </div>
          </div>
        )}
        {telemetry.data && telemetry.data.failures.length > 0 && (
          <div>
            <h2 className="text-sm font-medium mb-3">Recent failures</h2>
            <div className="space-y-2">
              {telemetry.data.failures.slice(0, 5).map((f) => (
                <Link
                  key={f.runId}
                  href={`/system/runs/${f.runId}`}
                  className="flex items-center justify-between gap-3 rounded-lg border border-red-500/40 bg-red-500/5 px-4 py-2.5 hover:border-red-400 transition-colors"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-(--ink)">
                      {f.status} · {f.modelId}
                    </div>
                    <div className="truncate text-xs text-(--mute)">{f.error ?? "—"}</div>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}
      </PageBody>
    </Page>
  );
}
