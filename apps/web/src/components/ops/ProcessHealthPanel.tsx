"use client";

import { Activity, Braces } from "lucide-react";
import type { SystemMetrics } from "./TelemetryKpiGrid";

/** Design's Process Memory & Health: per-process RSS/CPU cards. The daemon's
 *  own memory (rss/heap from `getSystemMetrics`, real on any OS) is always
 *  shown; spawned subprocesses (Linux /proc) appear when the backend reports
 *  them. */
export function ProcessHealthPanel({ metrics }: { metrics: SystemMetrics | undefined }) {
  if (!metrics) return null;

  const daemon = {
    pid: "—",
    name: "oma-core",
    status: "running" as const,
    rssMb: metrics.rssMb,
    cpu: null as number | null,
  };
  const subs = metrics.subprocesses.map((s) => ({
    pid: String(s.pid),
    name: s.cmd.split(" ")[0] ?? "child",
    status: "running" as const,
    rssMb: s.rssKb / 1024,
    cpu: s.cpuSec,
  }));
  const all = [daemon, ...subs];

  return (
    <div className="rounded-lg border border-(--hairline) bg-(--panel) p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 font-display text-sm font-semibold text-(--ink-strong)">
          <Braces size={14} className="text-(--primary)" />
          Process Memory &amp; Health
        </h2>
        <span className="font-label-caps text-label-caps uppercase tracking-wider text-(--mute)">
          {subs.length} process{subs.length === 1 ? "" : "es"} tracked
        </span>
      </div>
      <div className="space-y-2">
        {all.map((p) => (
          <div
            key={`${p.pid}-${p.name}`}
            className="rounded-lg border border-(--hairline) bg-(--canvas-soft) p-2.5"
          >
            <div className="flex items-center justify-between">
              <span className="font-mono text-[11px] text-(--ink-strong)">{p.name}</span>
              <span className="flex items-center gap-2 font-mono text-[9px] text-(--mute)">
                PID {p.pid}
                <span className="rounded border border-(--ok)/30 bg-(--ok)/10 px-1.5 py-0.5 font-label-caps text-label-caps uppercase text-(--ok)">
                  {p.status}
                </span>
              </span>
            </div>
            <div className="mt-1.5 flex items-center gap-3">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <Activity size={11} className="shrink-0 text-(--mute)" />
                <div className="h-1.5 flex-1 rounded-full bg-(--panel2) overflow-hidden">
                  <div
                    className="h-full rounded-full bg-(--primary)"
                    style={{ width: `${Math.min(100, (p.rssMb / 260) * 100)}%` }}
                  />
                </div>
              </div>
              <span className="shrink-0 font-mono text-[10px] text-(--body) tabular-nums">
                {Math.round(p.rssMb)} MB
              </span>
              {p.cpu != null && (
                <span className="shrink-0 font-mono text-[10px] text-(--faint) tabular-nums">
                  {p.cpu}s cpu
                </span>
              )}
              <span className="shrink-0 font-mono text-[10px] text-(--mute)">
                heap {Math.round(metrics.heapMb)}
              </span>
            </div>
          </div>
        ))}
        {subs.length === 0 && (
          <p className="text-[10px] text-(--faint)">
            Subprocess tracking is /proc-based (Linux); on this host only the daemon is reported.
          </p>
        )}
      </div>
    </div>
  );
}
