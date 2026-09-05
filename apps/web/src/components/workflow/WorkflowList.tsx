"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Page, PageBody, PageHeader } from "@/components/page";
import { KpiTile, StatusPill } from "@/components/patterns";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";

type Row = {
  workflowId: string;
  name?: string;
  description?: string;
  tags?: string[];
  status?: string;
  owner?: string;
  updatedBy?: string;
  updatedAt?: number;
  lastExecution?: {
    status: string;
    createdAt: number;
    terminalAt?: number;
    error?: string;
  };
  /** Cron trigger declarations (cron type only; API/manual are implicit). */
  triggers?: Array<{ type: "cron"; cron: string; enabled?: boolean }>;
};

function defaultDraft(id: string) {
  return {
    version: 1,
    id,
    meta: { name: id, status: "draft" },
    nodes: [
      { id: "start", type: "start" },
      { id: "done", type: "end", status: "success" },
    ],
    edges: [{ from: "start", to: "done" }],
  };
}

export function WorkflowList({ definitions }: { definitions: Row[] }) {
  const router = useRouter();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [runDef, setRunDef] = useState<{
    input?: Record<string, "string" | "number" | "boolean">;
  } | null>(null);
  const [runVals, setRunVals] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);

  const cronCount = definitions.filter((d) => (d.triggers ?? []).length > 0).length;
  const dayAgo = Date.now() - 86_400_000;
  const recentRuns = definitions.filter((d) => (d.lastExecution?.createdAt ?? 0) > dayAgo).length;
  const recentFailures = definitions.filter(
    (d) =>
      d.lastExecution &&
      d.lastExecution.status === "failure" &&
      (d.lastExecution.createdAt ?? 0) > dayAgo,
  ).length;

  async function create(templateId?: string) {
    const id = `wf-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    let def: Record<string, unknown> = defaultDraft(id) as Record<string, unknown>;
    if (templateId) {
      try {
        const t = await api.getWorkflowDefinition(templateId);
        if (t?.definition) {
          def = {
            ...(t.definition as Record<string, unknown>),
            id,
            triggers: [],
            meta: {
              ...((t.definition as { meta?: Record<string, unknown> }).meta ?? {}),
              name: `Copy of ${templateId}`,
              status: "draft",
            },
          };
        }
      } catch {
        /* template missing — fall back to blank draft */
      }
    }
    await api.saveWorkflowDefinition(id, def);
    router.push(`/workflows/${id}`);
  }
  async function openRun(id: string) {
    setRunId(id);
    setRunVals({});
    try {
      const def = await api.getWorkflowDefinition(id);
      setRunDef(def?.definition ?? null);
    } catch {
      setRunDef(null);
    }
  }
  async function run() {
    if (!runId || running) return;
    setRunning(true);
    const input: Record<string, unknown> = {};
    for (const [key, hint] of Object.entries(runDef?.input ?? {})) {
      const raw = runVals[key] ?? "";
      if (!raw) continue;
      input[key] = hint === "number" ? Number(raw) : hint === "boolean" ? raw === "true" : raw;
    }
    try {
      await api.startWorkflowExecution({
        workflowRef: { repo: "local", path: `${runId}.workflow.json` },
        input,
      });
      router.push(`/workflows/${runId}/executions`);
    } catch (err) {
      toast.error(`Run failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunning(false);
    }
  }
  async function del(id: string) {
    await api.deleteWorkflowDefinition(id);
    window.location.reload();
  }
  return (
    <Page>
      <PageHeader
        breadcrumb="Work / Workflows"
        title="Workflows"
        pill={
          cronCount > 0 ? <StatusPill tone="idle">{cronCount} scheduled</StatusPill> : undefined
        }
        actions={
          <Button size="sm" onClick={() => setNewOpen(true)}>
            + New
          </Button>
        }
      />
      <PageBody size="wide" className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <KpiTile label="Definitions" value={definitions.length} detail="workflows" />
          <KpiTile
            label="Scheduled"
            value={cronCount}
            detail="cron triggers"
            bar={definitions.length === 0 ? 0 : (cronCount / definitions.length) * 100}
            barTone="violet"
          />
          <KpiTile
            label="Last 24h runs"
            value={recentRuns}
            detail={recentFailures > 0 ? `${recentFailures} failed` : "all clear"}
            bar={recentRuns === 0 ? 0 : ((recentRuns - recentFailures) / recentRuns) * 100}
            barTone="ok"
          />
        </div>
        {definitions.map((d) => (
          <div
            key={d.workflowId}
            className="flex items-center justify-between rounded-xl border border-(--hairline) bg-(--panel)/70 p-3"
          >
            <div>
              <Link href={`/workflows/${d.workflowId}`} className="font-medium hover:underline">
                {d.name ?? d.workflowId}
              </Link>
              {d.description && (
                <div className="text-xs text-muted-foreground">{d.description}</div>
              )}
              <div className="mt-1 flex flex-wrap gap-1">
                {d.triggers?.some((t) => t.enabled !== false) && (
                  <span className="rounded-md bg-(--primary)/10 px-1.5 py-0.5 text-[10px] text-(--primary)">
                    ⏰ schedule · {d.triggers.find((t) => t.enabled !== false)!.cron}
                  </span>
                )}
                {d.tags?.map((t) => (
                  <span
                    key={t}
                    className="rounded-md bg-(--panel2) px-1.5 py-0.5 font-mono text-[10px] text-(--info)"
                  >
                    {t}
                  </span>
                ))}
                {d.status && (
                  <span className="rounded-full border border-(--primary)/40 bg-(--primary)/10 px-2 py-0.5 text-[10px] text-(--primary)">
                    {d.status}
                  </span>
                )}
              </div>
              {d.lastExecution && (
                <div className="mt-1 flex items-center gap-2 text-[10px] text-(--mute)">
                  <span
                    className={`rounded-full px-1.5 py-0.5 ${
                      d.lastExecution.status === "success"
                        ? "bg-(--primary)/10 text-(--primary)"
                        : d.lastExecution.status === "failure"
                          ? "bg-(--err)/10 text-(--err)"
                          : "bg-(--panel2) text-(--mute)"
                    }`}
                  >
                    {d.lastExecution.status === "waiting_human"
                      ? "Awaiting confirmation"
                      : d.lastExecution.status}
                  </span>
                  <span>{new Date(d.lastExecution.createdAt).toLocaleString()}</span>
                  {d.lastExecution.terminalAt && d.lastExecution.createdAt && (
                    <span>
                      {Math.max(
                        0,
                        Math.round((d.lastExecution.terminalAt - d.lastExecution.createdAt) / 1000),
                      )}
                      s
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="flex shrink-0 gap-2 text-xs">
              <Button variant="outline" size="sm" onClick={() => openRun(d.workflowId)}>
                Run
              </Button>
              <Link
                href={`/workflows/${d.workflowId}/executions`}
                className="rounded-md border border-(--hairline) bg-(--panel) px-2 py-1 text-(--body) transition-colors hover:bg-(--panel2)"
              >
                Executions
              </Link>
              <Button variant="destructive" size="sm" onClick={() => setConfirmId(d.workflowId)}>
                Delete
              </Button>
            </div>
          </div>
        ))}
        {definitions.length === 0 && (
          <div className="text-sm text-muted-foreground">
            No workflows yet — press <b>+ New</b> above to start from a template.
          </div>
        )}
      </PageBody>
      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold">New Workflow</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-start"
              onClick={() => void create()}
            >
              <div className="font-medium">Blank canvas</div>
              <div className="text-[10px] text-(--mute)">start → end, build from scratch</div>
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-start"
              onClick={() => void create("nighttime-report")}
            >
              <div className="font-medium">Nightly code quality report</div>
              <div className="text-[10px] text-(--mute)">
                Agent scans repo → report → human confirmation
              </div>
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-start"
              onClick={() => void create("self-heal")}
            >
              <div className="font-medium">Issue self-heal</div>
              <div className="text-[10px] text-(--mute)">
                Detect → auto-fix → human confirm → fork exit
              </div>
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={runId !== null}
        onOpenChange={(o) => {
          if (!o) setRunId(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold">Run {runId}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {Object.keys(runDef?.input ?? {}).length === 0 ? (
              <p className="text-xs text-(--mute)">This workflow has no input parameters.</p>
            ) : (
              Object.entries(runDef?.input ?? {}).map(([key, hint]) => (
                <div key={key} className="flex flex-col gap-1">
                  <Label className="text-xs text-(--mute)">
                    {key} <span className="text-(--faint)">({hint})</span>
                  </Label>
                  <Input
                    className="h-9 border-(--hairline) bg-(--canvas) text-xs"
                    type={hint === "number" ? "number" : hint === "boolean" ? "text" : "text"}
                    placeholder={hint === "boolean" ? "true / false" : ""}
                    value={runVals[key] ?? ""}
                    onChange={(e) => setRunVals((v) => ({ ...v, [key]: e.target.value }))}
                  />
                </div>
              ))
            )}
            <Button className="w-full" onClick={run} disabled={running}>
              {running ? "Starting…" : "Run"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={confirmId !== null}
        onOpenChange={(o) => {
          if (!o) setConfirmId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete workflow {confirmId}?</AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmId) void del(confirmId);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}
