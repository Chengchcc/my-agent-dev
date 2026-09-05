"use client";
import { Activity, Download, XCircle } from "lucide-react";
import { toast } from "sonner";
import { AgentRunsTable } from "@/components/ops/AgentRunsTable";
import { ProcessHealthPanel } from "@/components/ops/ProcessHealthPanel";
import { QueryState } from "@/components/ops/QueryState";
import { SurfaceHealthPanel } from "@/components/ops/SurfaceHealthPanel";
import { TelemetryKpiGrid } from "@/components/ops/TelemetryKpiGrid";
import { TokenAreaChart } from "@/components/ops/TokenAreaChart";
import { Page, PageBody, PageHeader } from "@/components/page";
import { StatusPill } from "@/components/patterns";
import {
  useAgentRuns,
  useCancelAgentRun,
  useSurfaces,
  useSystemMetrics,
  useTelemetrySummary,
} from "@/features/ops/hooks";

export default function SystemPage() {
  const surfacesQuery = useSurfaces();
  const runsQuery = useAgentRuns();
  const cancelRun = useCancelAgentRun();
  const telemetryQuery = useTelemetrySummary();
  const { data: metrics } = useSystemMetrics();

  const surfaces = surfacesQuery.data ?? [];
  const runs = runsQuery.data?.runs ?? [];

  const healthySurfaces = surfaces.filter((s) => s.status === "running").length;
  const runningRuns = runs.filter((r) => ["running", "waiting"].includes(r.status)).length;
  // Backend reachable = the ops surfaces query resolved (not errored / not loading to failure).
  const backendOnline = !surfacesQuery.isError;

  return (
    <Page>
      <PageHeader
        breadcrumb="System / Observability"
        title="System"
        pill={
          runningRuns > 0 ? (
            <StatusPill tone="running">live monitor</StatusPill>
          ) : (
            <StatusPill tone="idle">nominal</StatusPill>
          )
        }
        action={
          <button
            type="button"
            onClick={() => exportOpsBundle(runs, surfaces, metrics, telemetryQuery.data)}
            className="flex items-center gap-1.5 rounded-sm border border-(--hairline) bg-(--panel2)/50 px-3 py-1.5 text-xs text-(--ink) transition-colors hover:border-(--faint)"
          >
            <Download size={13} />
            Export Ops Bundle
          </button>
        }
      />
      {/* Live status banner: real subsystem health, not prose */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-(--hairline) bg-(--panel) px-4 py-2.5 font-mono text-[10px] uppercase tracking-kicker text-(--mute)">
        <span className="flex items-center gap-1.5 text-(--ok)">
          <span
            className={`size-1.5 rounded-full ${backendOnline ? "bg-(--ok) animate-pulse" : "bg-(--err)"}`}
          />
          backend {backendOnline ? "SSE on" : "unreachable"}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="text-(--faint)">uptime</span>
          <span className="text-(--ink-strong)">
            {metrics ? fmtUptime(metrics.uptimeSec) : "—"}
          </span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="text-(--faint)">rss</span>
          <span className="text-(--ink-strong)">
            {metrics ? `${Math.round(metrics.rssMb)}MB` : "—"}
          </span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="text-(--faint)">db</span>
          <span className="text-(--ink-strong)">
            {metrics?.dbSizeBytes != null
              ? `${(metrics.dbSizeBytes / 1024 / 1024).toFixed(1)}MB`
              : "—"}
          </span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="text-(--faint)">subprocesses</span>
          <span className="text-(--ink-strong)">{metrics?.subprocesses.length ?? 0}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="text-(--faint)">tokens 24h</span>
          <span className="text-(--ink-strong)">
            {telemetryQuery.data
              ? fmtTokens(telemetryQuery.data.inputTokens + telemetryQuery.data.outputTokens)
              : "—"}
          </span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="text-(--faint)">cost 24h</span>
          <span className="text-(--ink-strong)">
            {telemetryQuery.data ? `$${telemetryQuery.data.costUsd.toFixed(2)}` : "—"}
          </span>
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-(--faint)">
          {healthySurfaces}/{surfaces.length} surfaces live
        </span>
      </div>
      <PageBody className="space-y-6">
        <TelemetryKpiGrid metrics={metrics} />

        <div className="grid items-start gap-4 lg:grid-cols-5">
          <div className="min-w-0 space-y-4 lg:col-span-3">
            <div className="flex items-center gap-2.5">
              <h2 className="font-display text-lg font-semibold tracking-tight text-(--ink-strong)">
                Runtime telemetry
              </h2>
              <StatusPill tone="idle">24h window</StatusPill>
            </div>
            {telemetryQuery.data && telemetryQuery.data.costByHour.length > 0 && (
              <TokenAreaChart data={telemetryQuery.data} />
            )}
          </div>
          <div className="min-w-0 space-y-4 lg:col-span-2">
            <ProcessHealthPanel metrics={metrics} />
            <div className="flex items-center gap-2.5">
              <h2 className="font-display text-lg font-semibold tracking-tight text-(--ink-strong)">
                Surfaces &amp; health
              </h2>
              <StatusPill tone="idle">
                {healthySurfaces}/{surfaces.length} live
              </StatusPill>
            </div>
            <QueryState
              query={surfacesQuery}
              empty={(d) => d.length === 0}
              emptyTitle="No Lark surfaces reporting"
              emptyDescription="Lark surface health appears after a Lark bot agent connects."
              emptyIcon={XCircle}
            >
              {(data) => (
                <div className="space-y-3">
                  {data.map((s) => (
                    <SurfaceHealthPanel
                      key={`${s.agentId}-${s.surface}`}
                      surface={{
                        agentId: s.agentId,
                        agentName: s.agentName,
                        surface: s.surface,
                        status: s.status,
                        lastSeenAt: s.lastSeenAt,
                        lastError: s.lastError,
                        counters: s.counters,
                      }}
                    />
                  ))}
                </div>
              )}
            </QueryState>
          </div>
        </div>

        <div className="space-y-4">
          <div className="flex items-center gap-2.5">
            <h2 className="font-display text-lg font-semibold tracking-tight text-(--ink-strong)">
              Agent runs
            </h2>
            <StatusPill tone={runningRuns > 0 ? "running" : "idle"}>
              {runningRuns} active
            </StatusPill>
          </div>
          <QueryState
            query={runsQuery}
            empty={(d) => d.runs.length === 0}
            emptyTitle="No Agent Runs yet"
            emptyDescription="Runs appear after the first workflow or agent run."
            emptyIcon={Activity}
          >
            {(data) => (
              <AgentRunsTable
                runs={data.runs.map((r) => ({
                  runId: r.runId,
                  status: r.status,
                  agentId: r.agentId ?? "",
                  model: r.model.modelId,
                  createdAt: r.createdAt,
                  terminalAt: r.terminalAt,
                  usage: r.usage ?? null,
                  error: r.error ?? null,
                }))}
                onCancel={(runId) =>
                  cancelRun.mutate(runId, {
                    onSuccess: () => toast.success("Cancel requested"),
                    onError: () => toast.error("Cancel failed"),
                  })
                }
              />
            )}
          </QueryState>
        </div>
      </PageBody>
    </Page>
  );
}

/** `3h 12m` — uptime from seconds. */
function fmtUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Download the live ops snapshot (metrics + surfaces + runs + telemetry) as a
 *  JSON "ops bundle". */
function exportOpsBundle(runs: unknown, surfaces: unknown, metrics: unknown, telemetry: unknown) {
  const bundle = {
    exportedAt: new Date().toISOString(),
    metrics,
    surfaces,
    runs,
    telemetry,
  };
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ops-bundle-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
