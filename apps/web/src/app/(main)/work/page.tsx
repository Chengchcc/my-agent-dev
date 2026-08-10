"use client";

import { CheckCircle2 } from "lucide-react";
import Link from "next/link";
import { QueryState } from "@/components/ops/QueryState";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { ReviewQueueCard } from "@/components/work/ReviewQueueCard";
import { useLoopList } from "@/features/loop/hooks";
import { useAgentRuns } from "@/features/ops/hooks";
import { useWorkToday } from "@/features/work/hooks";
import type { LoopRow } from "@/lib/api";

export const dynamic = "force-dynamic";

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

export default function WorkTodayPage() {
  const useWorkTodayResult = useWorkToday();
  const { data } = useWorkTodayResult;
  const queue = data?.reviewQueue ?? [];
  const { data: loopsData } = useLoopList();
  const { data: runs } = useAgentRuns();

  const draftLoops = (loopsData?.loops ?? []).filter((l: LoopRow) => l.enabled === false);

  const todayRuns = (runs?.runs ?? []).filter((r) => isToday(r.createdAt));
  const succeeded = todayRuns.filter((r) => r.status === "completed").length;
  const failed = todayRuns.filter(
    (r) => r.status === "failed" || r.status === "aborted" || r.status === "timeout",
  ).length;
  const running = todayRuns.filter(
    (r) => r.status === "running" || r.status === "waiting" || r.status === "commit_failed",
  ).length;

  // Usage totals from Agent Run terminal results (no checkpoint-event pipeline)
  const totalTokens = (runs?.runs ?? [])
    .filter((r) => isToday(r.createdAt))
    .reduce((sum, r) => sum + (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0), 0);
  const tokensUnavailable = false;
  const today = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <Page>
      <PageHeader breadcrumb="Work Today" title="Work Today" description={today} />
      <PageBody size="reading" className="space-y-8">
        <div>
          <h2 className="text-sm font-medium mb-3">
            Review Queue {queue.length > 0 && `(${queue.length})`}
          </h2>
          <QueryState
            query={useWorkTodayResult}
            empty={(d) => d.reviewQueue.length === 0}
            emptyTitle="Nothing waiting for review"
            emptyDescription="Completed Loop steps that need your review will appear here."
            emptyIcon={CheckCircle2}
          >
            {(d) => (
              <div className="grid gap-3">
                {d.reviewQueue.map((item) => (
                  <ReviewQueueCard key={item.id} item={item} />
                ))}
              </div>
            )}
          </QueryState>
        </div>

        {draftLoops.length > 0 && (
          <div>
            <h2 className="text-sm font-medium mb-3">Draft Loops ({draftLoops.length})</h2>
            <div className="grid gap-3">
              {draftLoops.map((loop) => (
                <Link
                  key={loop.cronJobId}
                  href={`/work/${loop.cronJobId}`}
                  className="block rounded-lg border border-[var(--hairline)] bg-[var(--canvas-soft)] px-4 py-3 hover:border-[var(--primary)] transition-colors"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-sm font-medium text-[var(--ink)]">
                        <span className="truncate">{loop.name}</span>
                        {loop.pendingCount > 0 && (
                          <Badge variant="default" className="text-xs">
                            {loop.pendingCount} pending
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-[var(--mute)] font-mono">
                        {loop.cronExpr || "Manual"}
                      </div>
                    </div>
                    <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full border border-[var(--hairline)] text-[var(--mute)] uppercase tracking-[0.15em]">
                      Draft
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}

        <div>
          <h2 className="text-sm font-medium mb-3">Today&apos;s Runs</h2>
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-lg border border-[var(--hairline)] bg-[var(--canvas-soft)] px-4 py-4">
              <div className="text-2xl font-semibold text-emerald-400 tabular-nums">
                {succeeded}
              </div>
              <div className="text-xs text-[var(--mute)]">Succeeded</div>
            </div>
            <div className="rounded-lg border border-[var(--hairline)] bg-[var(--canvas-soft)] px-4 py-4">
              <div className="text-2xl font-semibold text-red-400 tabular-nums">{failed}</div>
              <div className="text-xs text-[var(--mute)]">Failed</div>
            </div>
            <div className="rounded-lg border border-[var(--hairline)] bg-[var(--canvas-soft)] px-4 py-4">
              <div className="text-2xl font-semibold text-amber-400 tabular-nums">{running}</div>
              <div className="text-xs text-[var(--mute)]">Running</div>
            </div>
          </div>
          <div className="mt-3 rounded-lg border border-[var(--hairline)] bg-[var(--canvas-soft)] px-4 py-4 text-center">
            <div className="text-2xl font-semibold text-[var(--ink)] tabular-nums">
              {tokensUnavailable ? "Token data unavailable" : totalTokens.toLocaleString()}
            </div>
            <div className="text-xs text-[var(--mute)]">Total Tokens</div>
          </div>
        </div>
      </PageBody>
    </Page>
  );
}
