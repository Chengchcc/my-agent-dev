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
      ? "text-emerald-600"
      : tone === "warn"
        ? "text-amber-600"
        : tone === "bad"
          ? "text-red-600"
          : "text-[var(--ink)]";
  return (
    <div className="rounded-lg border border-[var(--hairline)] bg-[var(--canvas)] p-3">
      <div className="flex items-center gap-1.5 text-xs text-[var(--mute)]">
        <Icon className="h-3.5 w-3.5" aria-hidden />
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
            label="Healthy surfaces"
            value={`${healthySurfaces} / ${surfaces.length}`}
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

          <TabsContent value="surfaces" className="pt-4">
            <QueryState
              query={surfacesQuery}
              empty={(d) => d.length === 0}
              emptyTitle="No surfaces reporting"
              emptyDescription="Surface health appears after an agent connects through Web or Lark."
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

          <TabsContent value="runs" className="pt-4">
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

          <TabsContent value="cron" className="pt-4">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-medium text-[var(--ink)]">Schedules</h2>
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
                      className="flex items-center justify-between rounded-lg border border-[var(--hairline)] p-3"
                    >
                      <div className="flex items-center gap-3">
                        <Badge variant="outline">{job.cronExpr}</Badge>
                        <span className="text-sm font-medium">{job.name}</span>
                        <span className="text-xs text-[var(--mute)]">agent: {job.agentId}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={job.enabled}
                          onCheckedChange={(checked) =>
                            setCronEnabled.mutate({ id: job.cronJobId, enabled: checked })
                          }
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive"
                          onClick={() => deleteCron.mutate(job.cronJobId)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
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
