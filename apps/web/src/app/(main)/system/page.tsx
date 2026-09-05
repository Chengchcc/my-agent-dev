"use client";
import { Activity, CalendarClock, CircleAlert, Coins, Plug, XCircle } from "lucide-react";
import Link from "next/link";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import { AgentRunsTable } from "@/components/ops/AgentRunsTable";
import { QueryState } from "@/components/ops/QueryState";
import { SurfaceHealthPanel } from "@/components/ops/SurfaceHealthPanel";
import { Page, PageBody, PageHeader } from "@/components/page";
import { KpiTile, MonoLabel, StatusPill } from "@/components/patterns";
import { Badge } from "@/components/ui/badge";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import {
  useAgentRuns,
  useCancelAgentRun,
  useSurfaces,
  useSystemMetrics,
  useTelemetrySummary,
} from "@/features/ops/hooks";

const FAILURE_TIPS: Record<string, string> = {
  timeout: "Try increasing max steps or reducing task scope.",
  schema: "Validate the workflow/input schema before rerunning.",
  permission: "Grant the missing permission or switch to a permitted tool.",
  network: "Check provider connectivity/credentials before retrying.",
  other: "Review the latest failures for a common fix.",
};

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
  const failedToday = runs.filter(
    (r) => r.status === "failed" && r.createdAt > Date.now() - 86_400_000,
  ).length;

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
      />
      <p className="px-2 text-xs text-(--mute) md:px-0">
        Runtime health, active runs, and execution telemetry.
      </p>
      <PageBody className="space-y-6">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <KpiTile
            label="Lark surfaces"
            value={surfaces.length === 0 ? "—" : `${healthySurfaces}/${surfaces.length}`}
            icon={Plug}
            detail={surfaces.length === 0 ? "no surfaces" : "surface health"}
            bar={surfaces.length === 0 ? 0 : (healthySurfaces / surfaces.length) * 100}
            barTone="ok"
          />
          <KpiTile
            label="Running"
            value={runningRuns}
            icon={Activity}
            detail="active runs"
            bar={runningRuns > 0 ? 100 : 0}
            barTone="primary"
          />
          <KpiTile
            label="Failed 24h"
            value={failedToday}
            icon={CircleAlert}
            detail={failedToday > 0 ? "needs review" : "clean"}
            bar={failedToday > 0 ? 100 : 0}
            barTone="err"
          />
          <KpiTile
            label="Runs 24h"
            value={telemetryQuery.data?.runs ?? 0}
            icon={CalendarClock}
            detail={
              telemetryQuery.data
                ? `${formatTokens(telemetryQuery.data.inputTokens + telemetryQuery.data.outputTokens)} tokens`
                : "—"
            }
          />
          <KpiTile
            label="Cost 24h"
            value={telemetryQuery.data ? `$${telemetryQuery.data.costUsd.toFixed(2)}` : "—"}
            icon={Coins}
            detail={telemetryQuery.data ? `${telemetryQuery.data.toolCalls} tool calls` : "—"}
          />
        </div>

        {metrics && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-lg border border-(--hairline) bg-(--panel) px-4 py-2 font-mono text-[10px] uppercase tracking-kicker text-(--mute)">
            <span>
              uptime {Math.floor(metrics.uptimeSec / 3600)}h{" "}
              {Math.floor((metrics.uptimeSec % 3600) / 60)}m
            </span>
            <span>rss {metrics.rssMb}mb</span>
            <span>heap {metrics.heapMb}mb</span>
            {metrics.dbSizeBytes != null && (
              <span>db {Math.round(metrics.dbSizeBytes / 1024 / 1024)}mb</span>
            )}
            <span>subprocesses {metrics.subprocesses.length}</span>
            {metrics.subprocesses.map((p: { pid: number; cpuSec: number }) => (
              <span key={p.pid} className="text-(--faint)">
                pid {p.pid} · {p.cpuSec}s
              </span>
            ))}
          </div>
        )}

        <div className="grid items-start gap-4 lg:grid-cols-12">
          <div className="min-w-0 space-y-4 lg:col-span-7">
            <div className="flex items-center gap-2.5">
              <h2 className="font-display text-lg font-semibold tracking-tight text-(--ink-strong)">
                Runtime telemetry
              </h2>
              <StatusPill tone="idle">24h window</StatusPill>
            </div>
            {telemetryQuery.data && telemetryQuery.data.costByHour.length > 0 && (
              <div className="rounded-lg border border-(--hairline) bg-(--panel) p-4">
                <MonoLabel>Token consumption &amp; cost burn</MonoLabel>
                <ChartContainer
                  config={{ costUsd: { label: "Cost", color: "var(--chart-1)" } }}
                  className="mt-2 h-28 w-full"
                >
                  <BarChart data={telemetryQuery.data.costByHour}>
                    <CartesianGrid vertical={false} />
                    <XAxis
                      dataKey="hour"
                      tickFormatter={(h: number) =>
                        new Date(h).toLocaleTimeString(undefined, { hour: "numeric" })
                      }
                    />
                    <YAxis width={40} tickFormatter={(v: number) => `$${v}`} />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Bar dataKey="costUsd" fill="var(--chart-1)" radius={2} />
                  </BarChart>
                </ChartContainer>
              </div>
            )}
            <QueryState
              query={telemetryQuery}
              empty={(d) => d.runs === 0}
              emptyTitle="No telemetry yet"
              emptyDescription="Run telemetry (tokens, tool calls, duration) appears after Agent Runs execute."
              emptyIcon={Activity}
            >
              {(d) => (
                <div className="space-y-4">
                  {d.byAgent.length > 0 && (
                    <div className="rounded-lg border border-(--hairline) p-3">
                      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-(--mute)">
                        Agent success rate
                      </h3>
                      <ChartContainer
                        config={{
                          rate: { label: "Success", color: "hsl(var(--primary))" },
                        }}
                        className="h-32 w-full"
                      >
                        <BarChart
                          data={d.byAgent.map((a) => ({
                            agentId: a.agentId,
                            rate: a.successRate == null ? 0 : Math.round(a.successRate * 100),
                          }))}
                          layout="vertical"
                        >
                          <CartesianGrid horizontal={false} />
                          <XAxis
                            type="number"
                            domain={[0, 100]}
                            tickFormatter={(v: number) => `${v}%`}
                          />
                          <YAxis
                            type="category"
                            dataKey="agentId"
                            width={90}
                            tickFormatter={(v: string) => v.slice(0, 16)}
                          />
                          <ChartTooltip content={<ChartTooltipContent />} />
                          <Bar dataKey="rate" fill="var(--color-rate)" radius={4} />
                        </BarChart>
                      </ChartContainer>
                    </div>
                  )}
                  {d.byModel.length > 0 && (
                    <div className="rounded-lg border border-(--hairline) p-3">
                      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-(--mute)">
                        Cost by model
                      </h3>
                      <ChartContainer
                        config={{
                          cost: { label: "Cost", color: "hsl(var(--primary))" },
                        }}
                        className="h-24 w-full"
                      >
                        <BarChart
                          data={d.byModel.map((m) => ({
                            model: m.modelId,
                            cost: m.costUsd,
                          }))}
                        >
                          <CartesianGrid vertical={false} />
                          <XAxis
                            dataKey="model"
                            tickFormatter={(v: string) => v.split("/").pop() ?? v}
                          />
                          <YAxis width={50} tickFormatter={(v: number) => `$${v}`} />
                          <ChartTooltip content={<ChartTooltipContent />} />
                          <Bar dataKey="cost" fill="var(--color-cost)" radius={4} />
                        </BarChart>
                      </ChartContainer>
                    </div>
                  )}
                  {d.successRateByDay.length > 0 && (
                    <div className="rounded-lg border border-(--hairline) p-3">
                      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-(--mute)">
                        Success rate (7d)
                      </h3>
                      <ChartContainer
                        config={{
                          rate: { label: "Success", color: "hsl(var(--primary))" },
                        }}
                        className="h-24 w-full"
                      >
                        <BarChart
                          data={d.successRateByDay.map((day) => ({
                            dayStart: day.dayStart,
                            rate: day.successRate == null ? 0 : Math.round(day.successRate * 100),
                          }))}
                        >
                          <CartesianGrid vertical={false} />
                          <XAxis
                            dataKey="dayStart"
                            tickFormatter={(v: number) =>
                              new Date(v).toLocaleDateString(undefined, {
                                month: "short",
                                day: "numeric",
                              })
                            }
                          />
                          <YAxis
                            width={40}
                            domain={[0, 100]}
                            tickFormatter={(v: number) => `${v}%`}
                          />
                          <ChartTooltip content={<ChartTooltipContent />} />
                          <Bar dataKey="rate" fill="var(--color-rate)" radius={4} />
                        </BarChart>
                      </ChartContainer>
                    </div>
                  )}
                  {d.durationByDay.length > 0 && (
                    <div className="rounded-lg border border-(--hairline) p-3">
                      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-(--mute)">
                        Avg duration (7d)
                      </h3>
                      <ChartContainer
                        config={{
                          durationSec: { label: "Duration", color: "hsl(var(--primary))" },
                        }}
                        className="h-24 w-full"
                      >
                        <BarChart
                          data={d.durationByDay.map((day) => ({
                            dayStart: day.dayStart,
                            durationSec: day.avgDurationMs == null ? 0 : day.avgDurationMs / 1000,
                          }))}
                        >
                          <CartesianGrid vertical={false} />
                          <XAxis
                            dataKey="dayStart"
                            tickFormatter={(v: number) =>
                              new Date(v).toLocaleDateString(undefined, {
                                month: "short",
                                day: "numeric",
                              })
                            }
                          />
                          <YAxis width={40} tickFormatter={(v: number) => `${v}s`} />
                          <ChartTooltip content={<ChartTooltipContent />} />
                          <Bar dataKey="durationSec" fill="var(--color-durationSec)" radius={4} />
                        </BarChart>
                      </ChartContainer>
                    </div>
                  )}
                  {d.failureCauses.length > 0 && (
                    <div className="rounded-lg border border-(--hairline) p-3">
                      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-(--mute)">
                        Failure causes
                      </h3>
                      <div className="space-y-1">
                        {d.failureCauses.map((c) => (
                          <div key={c.cause} className="flex justify-between text-xs">
                            <span className="capitalize">{c.cause}</span>
                            <span className="text-(--mute)">{c.count}</span>
                          </div>
                        ))}
                      </div>
                      <p className="mt-2 text-xs text-(--mute)">
                        {FAILURE_TIPS[d.failureCauses[0]!.cause] ?? FAILURE_TIPS.other}
                      </p>
                    </div>
                  )}
                  {d.spinningRuns.length > 0 && (
                    <div className="rounded-lg border border-red-500/40 bg-red-500/5 p-3">
                      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-(--err)">
                        Spinning runs
                      </h3>
                      <div className="space-y-1">
                        {d.spinningRuns.map((r) => (
                          <Link
                            key={r.runId}
                            href={`/system/runs/${r.runId}`}
                            className="flex items-center justify-between gap-2 text-xs hover:underline"
                          >
                            <span className="font-mono">{r.runId.slice(0, 12)}</span>
                            <span className="shrink-0 text-(--mute)">
                              {r.toolCalls} tool calls ·{" "}
                              {r.durationMs == null ? "—" : `${(r.durationMs / 1000).toFixed(0)}s`}
                            </span>
                          </Link>
                        ))}
                      </div>
                      <p className="mt-2 text-xs text-(--err)">
                        Consider cancelling or retrying with a lower-cost model / higher maxSteps;
                        high tool calls with low output often means a loop.
                      </p>
                    </div>
                  )}
                  {d.failures.length > 0 && (
                    <div className="rounded-lg border border-(--hairline) p-3">
                      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-(--mute)">
                        Recent failures
                      </h3>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-(--hairline) text-left text-[10px] uppercase tracking-wider text-(--mute)">
                              <th className="px-2 py-1 font-semibold">Run</th>
                              <th className="px-2 py-1 font-semibold">Status</th>
                              <th className="px-2 py-1 font-semibold">Model</th>
                              <th className="px-2 py-1 font-semibold">Error</th>
                            </tr>
                          </thead>
                          <tbody>
                            {d.failures.map((f) => (
                              <tr
                                key={f.runId}
                                className="border-b border-(--hairline) last:border-b-0"
                              >
                                <td className="px-2 py-1 font-mono text-xs">
                                  {f.runId.slice(0, 12)}
                                </td>
                                <td className="px-2 py-1">
                                  <Badge variant="outline">{f.status}</Badge>
                                </td>
                                <td className="px-2 py-1 text-xs text-(--mute)">{f.modelId}</td>
                                <td className="px-2 py-1 text-xs">{f.error ?? "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                  <div className="overflow-x-auto rounded-lg border border-(--hairline)">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-(--hairline) text-left text-[10px] uppercase tracking-wider text-(--mute)">
                          <th className="px-3 py-2 font-semibold">Run</th>
                          <th className="px-3 py-2 font-semibold">Status</th>
                          <th className="px-3 py-2 font-semibold">Model</th>
                          <th className="px-3 py-2 font-semibold text-right">Tokens</th>
                          <th className="px-3 py-2 font-semibold text-right">Tools</th>
                          <th className="px-3 py-2 font-semibold text-right">Duration</th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.recent.map((r) => (
                          <tr
                            key={r.runId}
                            className="border-b border-(--hairline) last:border-b-0"
                          >
                            <td className="px-3 py-2 font-mono text-xs">{r.runId.slice(0, 12)}</td>
                            <td className="px-3 py-2">
                              <Badge variant="outline">{r.status}</Badge>
                            </td>
                            <td className="px-3 py-2 text-xs text-(--mute)">{r.modelId}</td>
                            <td className="px-3 py-2 text-right text-xs">
                              {formatTokens(r.inputTokens + r.outputTokens)}
                            </td>
                            <td className="px-3 py-2 text-right text-xs">{r.toolCalls}</td>
                            <td className="px-3 py-2 text-right text-xs">
                              {r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </QueryState>
          </div>
          <div className="min-w-0 space-y-4 lg:col-span-5">
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

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
