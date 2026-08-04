"use client";
import { Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { CronJobForm } from "@/components/CronJobForm";
import { AgentRunsTable } from "@/components/ops/AgentRunsTable";
import { QueryState } from "@/components/ops/QueryState";
import { SurfaceHealthPanel } from "@/components/ops/SurfaceHealthPanel";
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCronList, useDeleteCronJob, useSetCronEnabled } from "@/features/cron/hooks";
import { useAgentRuns, useCancelAgentRun, useSurfaces } from "@/features/ops/hooks";

type Tab = "surfaces" | "runs" | "cron";

export default function SystemPage() {
  const [tab, setTab] = useState<Tab>("surfaces");
  const surfacesQuery = useSurfaces();
  const runsQuery = useAgentRuns();
  const cronQuery = useCronList();
  const deleteCron = useDeleteCronJob();
  const setCronEnabled = useSetCronEnabled();
  const cancelRun = useCancelAgentRun();

  const cronJobs = (cronQuery.data?.cronJobs ?? []).filter((j) => !j.loopConfigPath);

  return (
    <div className="container mx-auto p-6 space-y-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbPage>System</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="surfaces">Surfaces</TabsTrigger>
          <TabsTrigger value="runs">Agent Runs</TabsTrigger>
          <TabsTrigger value="cron">Cron</TabsTrigger>
        </TabsList>

        <TabsContent value="surfaces" className="mt-4">
          <QueryState
            query={surfacesQuery}
            empty={(d) => d.length === 0}
            emptyMessage="No surfaces."
          >
            {(surfaces) => (
              <div className="space-y-3">
                {surfaces.map((s) => (
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

        <TabsContent value="runs" className="mt-4">
          <QueryState
            query={runsQuery}
            empty={(d) => d.runs.length === 0}
            emptyMessage="No Agent Runs yet."
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

        <TabsContent value="cron" className="mt-4">
          <CronJobForm />
          <div className="mt-4 space-y-2">
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
        </TabsContent>
      </Tabs>

      <div className="text-xs text-[var(--mute)]">
        Run detail:{" "}
        <Link href="/system/runs/example" className="underline">
          /system/runs/:runId
        </Link>
      </div>
    </div>
  );
}
