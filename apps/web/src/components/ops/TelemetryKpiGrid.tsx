"use client";

import { Cpu, Database, Gauge, Layers, Radio } from "lucide-react";
import { KpiTile } from "@/components/patterns";

/** Mirror of `api.getSystemMetrics()` — process-level health from the backend. */
export type SystemMetrics = {
  uptimeSec: number;
  rssMb: number;
  heapMb: number;
  dbSizeBytes: number | null;
  subprocesses: Array<{ pid: number; cmd: string; rssKb: number; cpuSec: number }>;
};

type MetricTile = {
  id: string;
  label: string;
  value: string;
  detail: string;
  icon: typeof Cpu;
  bar?: number;
  barTone?: "primary" | "ok" | "violet" | "err";
};

function fmtUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function fmtMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)}GB` : `${Math.round(mb)}MB`;
}

/** Design's telemetry KPI row (shares the canonical KpiTile with every other
 *  dashboard): icon + big value + detail + progress bar. */
export function TelemetryKpiGrid({ metrics }: { metrics: SystemMetrics | undefined }) {
  const tiles: MetricTile[] = [];

  if (metrics) {
    tiles.push(
      {
        id: "daemon",
        label: "Daemon Core",
        value: fmtUptime(metrics.uptimeSec),
        detail: "process uptime",
        icon: Cpu,
        bar: 100,
        barTone: "primary",
      },
      {
        id: "web",
        label: "Web Console",
        value: "SSE on",
        detail: "live event feed",
        icon: Radio,
        bar: 100,
        barTone: "ok",
      },
      {
        id: "db",
        label: "Database Ledger",
        value: metrics.dbSizeBytes != null ? fmtMb(metrics.dbSizeBytes / 1024 / 1024) : "—",
        detail: "sqlite file",
        icon: Database,
        bar: metrics.dbSizeBytes != null ? 88 : 0,
        barTone: "violet",
      },
      {
        id: "subproc",
        label: "Subprocesses",
        value: String(metrics.subprocesses.length),
        detail: "spawned children",
        icon: Layers,
        bar: metrics.subprocesses.length > 0 ? 100 : 0,
        barTone: "ok",
      },
      {
        id: "heap",
        label: "Heap Memory",
        value: fmtMb(metrics.heapMb),
        detail: "process heap",
        icon: Gauge,
        bar: 42,
        barTone: "primary",
      },
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {tiles.map((t) => (
        <KpiTile
          key={t.id}
          label={t.label}
          value={t.value}
          detail={t.detail}
          icon={t.icon}
          bar={t.bar}
          barTone={t.barTone}
        />
      ))}
    </div>
  );
}
