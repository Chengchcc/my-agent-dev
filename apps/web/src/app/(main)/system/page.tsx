"use client";
import { Activity, CalendarClock, CheckCircle2, CircleAlert, XCircle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AgentRunsTable } from "@/components/ops/AgentRunsTable";
import { QueryState } from "@/components/ops/QueryState";
import { SurfaceHealthPanel } from "@/components/ops/SurfaceHealthPanel";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useAgentRuns,
  useCancelAgentRun,
  useSurfaces,
  useTelemetrySummary,
} from "@/features/ops/hooks";

type Tab = "surfaces" | "runs" | "telemetry";

function SummaryCard({
  icon: Icon,
  label,
  value,
  tone = "default",
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  tone?: "default" | "ok" | "warn" | "bad";
}) {
  const toneColor =
    tone === "ok"
      ? "text-emerald-400"
      : tone === "warn"
        ? "text-amber-400"
        : tone === "bad"
          ? "text-red-400"
          : "text-[var(--ink)]";
  return (
    <div className="rounded-lg border border-(--hairline) bg-(--canvas) p-3">
      <div className="flex items-center gap-1.5 text-xs text-(--mute)">
        <Icon className="size-3.5 " aria-hidden />
        <span className="truncate">{label}</span>
      </div>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${toneColor}`}>{value}</p>
    </div>
  );
}

export default function SystemPage() {
  const [tab, setTab] = useState<Tab>("surfaces");
  const surfacesQuery = useSurfaces();
  const runsQuery = useAgentRuns();
  const cancelRun = useCancelAgentRun();
  const telemetryQuery = useTelemetrySummary();

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
        breadcrumb={[{ label: "System", href: "/system" }, { label: "Overview" }]}
        title="System"
        description="Runtime health, active runs, and scheduled work."
      />
      <PageBody className="space-y-6">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <SummaryCard
            icon={CheckCircle2}
            label="Lark surfaces"
            value={
              surfaces.length === 0 ? "No surfaces" : `${healthySurfaces} / ${surfaces.length}`
            }
            tone={surfaces.length > 0 && healthySurfaces === surfaces.length ? "ok" : "warn"}
          />
          <SummaryCard
            icon={Activity}
            label="Running"
            value={String(runningRuns)}
            tone={runningRuns > 0 ? "warn" : "default"}
          />
          <SummaryCard
            icon={CircleAlert}
            label="Failed today"
            value={String(failedToday)}
            tone={failedToday > 0 ? "bad" : "default"}
          />
        </div>

        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList variant="line" className="w-full justify-start">
            <TabsTrigger value="surfaces">Surfaces</TabsTrigger>
            <TabsTrigger value="runs">Agent Runs</TabsTrigger>
            <TabsTrigger value="telemetry">Telemetry</TabsTrigger>
          </TabsList>

          <TabsContent value="surfaces" className="w-full min-w-0 pt-4">
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
          </TabsContent>

          <TabsContent value="runs" className="w-full min-w-0 pt-4">
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
          </TabsContent>

          <TabsContent value="telemetry" className="w-full min-w-0 pt-4">
            <QueryState
              query={telemetryQuery}
              empty={(d) => d.runs === 0}
              emptyTitle="No telemetry yet"
              emptyDescription="Run telemetry (tokens, tool calls, duration) appears after Agent Runs execute."
              emptyIcon={Activity}
            >
              {(d) => (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                    <SummaryCard
                      icon={Activity}
                      label="Runs (24h)"
                      value={String(d.runs)}
                      tone="default"
                    />
                    <SummaryCard
                      icon={CircleAlert}
                      label="Tokens"
                      value={`${formatTokens(d.inputTokens + d.outputTokens)}`}
                      tone="default"
                    />
                    <SummaryCard
                      icon={CheckCircle2}
                      label="Tool calls"
                      value={String(d.toolCalls)}
                      tone="default"
                    />
                    <SummaryCard
                      icon={CalendarClock}
                      label="Cost"
                      value={`$${d.costUsd.toFixed(4)}`}
                      tone="default"
                    />
                  </div>
                  {d.byAgent.length > 0 && (
                    <div className="rounded-lg border border-(--hairline) p-3">
                      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-(--mute)">
                        Agent success rate
                      </h3>
                      <div className="space-y-2">
                        {d.byAgent.map((a) => (
                          <div key={a.agentId} className="text-xs">
                            <div className="mb-1 flex items-center justify-between gap-2">
                              <span className="truncate font-mono">{a.agentId}</span>
                              <span className="shrink-0 text-(--mute)">
                                {a.completed}/{a.runs} · {a.failed} failed ·{" "}
                                {a.successRate == null
                                  ? "—"
                                  : `${Math.round(a.successRate * 100)}%`}
                              </span>
                            </div>
                            <div className="h-1.5 rounded bg-(--mute)/30">
                              <div
                                className="h-full rounded bg-emerald-400"
                                style={{
                                  width: `${a.successRate == null ? 0 : a.successRate * 100}%`,
                                }}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {d.byModel.length > 0 && (
                    <div className="rounded-lg border border-(--hairline) p-3">
                      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-(--mute)">
                        Cost by model
                      </h3>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-(--hairline) text-left text-[10px] uppercase tracking-wider text-(--mute)">
                              <th className="px-2 py-1 font-semibold">Model</th>
                              <th className="px-2 py-1 font-semibold text-right">Runs</th>
                              <th className="px-2 py-1 font-semibold text-right">Success</th>
                              <th className="px-2 py-1 font-semibold text-right">Cost</th>
                              <th className="px-2 py-1 font-semibold text-right">Tokens</th>
                            </tr>
                          </thead>
                          <tbody>
                            {d.byModel.map((m) => {
                              const terminal = m.completed + m.failed;
                              const rate =
                                terminal > 0 ? Math.round((m.completed / terminal) * 100) : null;
                              return (
                                <tr
                                  key={m.modelId}
                                  className="border-b border-(--hairline) last:border-b-0"
                                >
                                  <td className="px-2 py-1 text-xs text-(--mute)">{m.modelId}</td>
                                  <td className="px-2 py-1 text-right text-xs">{m.runs}</td>
                                  <td className="px-2 py-1 text-right text-xs">
                                    {rate == null ? "—" : `${rate}%`}
                                  </td>
                                  <td className="px-2 py-1 text-right text-xs">
                                    ${m.costUsd.toFixed(4)}
                                  </td>
                                  <td className="px-2 py-1 text-right text-xs">{m.tokens}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                  {d.successRateByDay.length > 0 && (
                    <div className="rounded-lg border border-(--hairline) p-3">
                      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-(--mute)">
                        Success rate (7d)
                      </h3>
                      <div className="space-y-2">
                        {d.successRateByDay.map((day) => {
                          const rate =
                            day.successRate == null ? null : Math.round(day.successRate * 100);
                          return (
                            <div key={day.dayStart} className="text-xs">
                              <div className="mb-1 flex items-center justify-between gap-2">
                                <span className="text-(--mute)">
                                  {new Date(day.dayStart).toLocaleDateString()}
                                </span>
                                <span className="shrink-0 text-(--mute)">
                                  {day.completed}/{day.runs} · {rate == null ? "—" : `${rate}%`}
                                </span>
                              </div>
                              <div className="h-1.5 rounded bg-(--mute)/30">
                                <div
                                  className="h-full rounded bg-emerald-400"
                                  style={{ width: `${rate == null ? 0 : rate}%` }}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
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
          </TabsContent>
        </Tabs>
      </PageBody>
    </Page>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
