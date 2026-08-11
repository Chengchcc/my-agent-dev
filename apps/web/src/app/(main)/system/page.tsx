"use client";
import { Activity, CalendarClock, CheckCircle2, CircleAlert, Trash2, XCircle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { CronJobForm } from "@/components/CronJobForm";
import { AgentRunsTable } from "@/components/ops/AgentRunsTable";
import { QueryState } from "@/components/ops/QueryState";
import { SurfaceHealthPanel } from "@/components/ops/SurfaceHealthPanel";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCronList, useDeleteCronJob, useSetCronEnabled } from "@/features/cron/hooks";
import { useAgentRuns, useCancelAgentRun, useSurfaces } from "@/features/ops/hooks";

type Tab = "surfaces" | "runs" | "cron";

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
  const cronQuery = useCronList();
  const deleteCron = useDeleteCronJob();
  const setCronEnabled = useSetCronEnabled();
  const cancelRun = useCancelAgentRun();
  const [confirmingJobId, setConfirmingJobId] = useState<string | null>(null);

  const surfaces = surfacesQuery.data ?? [];
  const runs = runsQuery.data?.runs ?? [];
  const cronJobs = (cronQuery.data?.cronJobs ?? []).filter((j) => !j.loopConfigPath);

  const healthySurfaces = surfaces.filter((s) => s.status === "running").length;
  const runningRuns = runs.filter((r) => ["running", "waiting"].includes(r.status)).length;
  const failedToday = runs.filter(
    (r) => r.status === "failed" && r.createdAt > Date.now() - 86_400_000,
  ).length;
  const enabledSchedules = cronJobs.filter((j) => j.enabled).length;

  return (
    <Page>
      <PageHeader
        breadcrumb="System"
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
          <SummaryCard
            icon={CalendarClock}
            label="Schedules"
            value={String(enabledSchedules)}
            tone="default"
          />
        </div>

        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList variant="line" className="w-full justify-start">
            <TabsTrigger value="surfaces">Surfaces</TabsTrigger>
            <TabsTrigger value="runs">Agent Runs</TabsTrigger>
            <TabsTrigger value="cron">Schedules</TabsTrigger>
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
              emptyDescription="Runs appear after the first conversation, cron or Loop execution."
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

          <TabsContent value="cron" className="w-full min-w-0 pt-4">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-medium text-(--ink)">Schedules</h2>
              {/* The primary action lives with its tab content, not the tab row. */}
              <CronJobForm />
            </div>
            <QueryState
              query={cronQuery}
              empty={(d) => (d.cronJobs ?? []).filter((j) => !j.loopConfigPath).length === 0}
              emptyTitle="No schedules"
              emptyDescription="Schedules run an agent on a timer; Loop configs live in Work."
              emptyIcon={CalendarClock}
            >
              {() => (
                <div className="space-y-2">
                  {cronJobs.map((job) => (
                    <div
                      key={job.cronJobId}
                      className="flex flex-col gap-3 rounded-lg border border-(--hairline) p-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <Badge variant="outline">{job.cronExpr}</Badge>
                        <span className="text-sm font-medium">{job.name}</span>
                        <span className="text-xs text-(--mute)">agent: {job.agentId}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={job.enabled}
                          onCheckedChange={(checked) =>
                            setCronEnabled.mutate({ id: job.cronJobId, enabled: checked })
                          }
                        />
                        {confirmingJobId === job.cronJobId ? (
                          <>
                            <Button
                              variant="destructive"
                              size="sm"
                              className="h-7"
                              onClick={() => {
                                deleteCron.mutate(job.cronJobId, {
                                  onSuccess: () => setConfirmingJobId(null),
                                });
                              }}
                            >
                              Confirm
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7"
                              onClick={() => setConfirmingJobId(null)}
                            >
                              Cancel
                            </Button>
                          </>
                        ) : (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7 text-destructive"
                            onClick={() => setConfirmingJobId(job.cronJobId)}
                          >
                            <Trash2 className="size-4 " />
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </QueryState>
          </TabsContent>
        </Tabs>
      </PageBody>
    </Page>
  );
}
