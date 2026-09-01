"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Page, PageBody, PageHeader } from "@/components/page";
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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { humanizeWorkflowError } from "./humanize-error";

type Exec = {
  executionId: string;
  triggeredBy?: string | null;
  status: string;
  exit?: string;
  error?: string;
  createdAt: number;
  terminalAt?: number;
};

function useLiveExecutions(workflowId: string, initial: Exec[]): Exec[] {
  const [rows, setRows] = useState<Exec[]>(initial);
  useEffect(() => {
    setRows(initial);
  }, [initial]);
  const anyRunning = rows.some((r) => r.status === "running" || r.status === "waiting_human");
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => {
      api
        .listWorkflowExecutions(workflowId)
        .then((r) => setRows((r?.executions ?? []) as Exec[]))
        .catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [anyRunning, workflowId]);
  return rows;
}

export function ExecutionList({
  workflowId,
  executions: initialExecutions,
  definition,
}: {
  workflowId: string;
  executions: Exec[];
  definition?: {
    input?: Array<{ key: string; type: "string" | "number" | "boolean" | "artifact" }>;
  } | null;
}) {
  const [inputVals, setInputVals] = useState<Record<string, string>>({});
  const [runOpen, setRunOpen] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [artifactSuggestions, setArtifactSuggestions] = useState<string[]>([]);
  const executions = useLiveExecutions(workflowId, initialExecutions);
  const inputHints = definition?.input ?? [];

  async function run() {
    const input: Record<string, unknown> = {};
    const artifacts: string[] = [];
    for (const f of inputHints) {
      const raw = inputVals[f.key] ?? "";
      if (raw === "") continue;
      if (f.type === "artifact") {
        // Validate artifact URLs exist before running.
        await api.downloadArtifact(raw).catch(() => {
          throw new Error(`artifact does not exist: ${f.key} = ${raw}`);
        });
        artifacts.push(raw);
        input[f.key] = raw;
      } else if (f.type === "number") input[f.key] = Number(raw);
      else if (f.type === "boolean") input[f.key] = raw === "true";
      else input[f.key] = raw;
    }
    try {
      await api.startWorkflowExecution({
        workflowRef: { repo: "local", path: `${workflowId}.workflow.json` },
        input,
        artifacts,
      });
      window.location.reload();
    } catch (err) {
      toast.error(`Run failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function del(executionId: string) {
    try {
      await api.deleteWorkflowExecution(executionId);
      window.location.reload();
    } catch (err) {
      toast.error(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: "Workflows", href: "/workflows" },
          { label: workflowId, href: `/workflows/${workflowId}` },
          { label: "Executions" },
        ]}
        title="Executions"
        description={`Runs of ${workflowId}`}
        action={
          <Dialog open={runOpen} onOpenChange={setRunOpen}>
            <button
              className="rounded-md bg-(--primary) px-3 py-1.5 text-xs text-(--ink) transition-colors hover:bg-(--panel2)"
              onClick={() => {
                setRunOpen(true);
                api
                  .listArtifacts()
                  .then((r) => setArtifactSuggestions((r.artifacts ?? []).map((a) => a.url)))
                  .catch(() => {});
              }}
            >
              + Run
            </button>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle className="text-sm font-semibold">Run {workflowId}</DialogTitle>
              </DialogHeader>
              <div className="space-y-3">
                {inputHints.length === 0 ? (
                  <p className="text-xs text-(--mute)">This workflow has no input parameters.</p>
                ) : (
                  inputHints.map((f) => (
                    <div key={f.key} className="flex flex-col gap-1">
                      <Label className="text-xs text-(--mute)">
                        {f.key} <span className="text-(--faint)">({f.type})</span>
                      </Label>
                      {f.type === "artifact" ? (
                        <div className="flex gap-1">
                          <input
                            list="run-artifact-suggestions"
                            className="h-9 flex-1 border-(--hairline) bg-(--canvas) px-2 text-xs"
                            placeholder="artifacts://folder/file"
                            value={inputVals[f.key] ?? ""}
                            onChange={(e) =>
                              setInputVals((v) => ({ ...v, [f.key]: e.target.value }))
                            }
                          />
                          <datalist id="run-artifact-suggestions">
                            {artifactSuggestions.map((u) => (
                              <option key={u} value={u} />
                            ))}
                          </datalist>
                        </div>
                      ) : (
                        <Input
                          className="h-9 border-(--hairline) bg-(--canvas) text-xs"
                          type={
                            f.type === "number" ? "number" : f.type === "boolean" ? "text" : "text"
                          }
                          placeholder={f.type === "boolean" ? "true / false" : ""}
                          value={inputVals[f.key] ?? ""}
                          onChange={(e) => setInputVals((v) => ({ ...v, [f.key]: e.target.value }))}
                        />
                      )}
                    </div>
                  ))
                )}
                <button
                  className="w-full rounded-md bg-(--primary) px-3 py-2 text-xs text-(--ink) hover:bg-(--panel2)"
                  onClick={async () => {
                    await run();
                    setRunOpen(false);
                  }}
                >
                  Submit
                </button>
              </div>
            </DialogContent>
          </Dialog>
        }
      />
      <PageBody className="space-y-2">
        {executions.map((e) => {
          const dur =
            e.terminalAt && e.createdAt
              ? Math.max(0, Math.round((e.terminalAt - e.createdAt) / 1000))
              : undefined;
          return (
            <div
              key={e.executionId}
              className="flex items-center justify-between gap-3 rounded-xl border border-(--hairline) bg-(--panel)/70 px-4 py-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  {e.triggeredBy?.startsWith("cron:") && (
                    <span className="rounded-full border border-(--hairline) px-1.5 py-0.5 font-mono text-[9px] text-(--mute)">
                      ⏰ {e.triggeredBy.slice(5)}
                    </span>
                  )}
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[10px] ${
                      e.status === "success"
                        ? "border-(--primary)/40 bg-(--primary)/10 text-(--primary)"
                        : e.status === "failure"
                          ? "border-(--err)/40 bg-(--err)/10 text-(--err)"
                          : e.status === "waiting_human"
                            ? "border-(--info)/40 bg-(--info)/10 text-(--info)"
                            : "border-(--hairline) bg-(--panel2) text-(--mute)"
                    }`}
                  >
                    {e.status === "waiting_human" ? "Awaiting confirmation" : e.status}
                  </span>
                  {dur !== undefined && <span className="text-[10px] text-(--mute)">{dur}s</span>}
                </div>
                <Link
                  href={`/workflows/${workflowId}/executions/${e.executionId}`}
                  className="mt-1 block truncate text-sm font-medium text-(--ink) hover:text-(--primary)"
                >
                  {new Date(e.createdAt).toLocaleString()}
                </Link>
              </div>
              {e.status === "failure" && e.error && (
                <div className="min-w-0 flex-1 truncate text-xs text-(--err)" title={e.error}>
                  {humanizeWorkflowError(e.error, [])?.title ?? e.error}
                </div>
              )}
              <div className="flex shrink-0 items-center gap-2">
                <Link
                  href={`/workflows/${workflowId}/executions/${e.executionId}`}
                  className="rounded-md border border-(--hairline) px-2.5 py-1 text-xs text-(--info) hover:bg-(--panel2)"
                >
                  View
                </Link>
                <button
                  className="rounded-md px-2 py-1 text-xs text-(--err) hover:bg-(--err)/10"
                  onClick={() => setConfirmId(e.executionId)}
                >
                  Delete
                </button>
              </div>
            </div>
          );
        })}
        {executions.length === 0 && (
          <div className="mt-4 text-sm text-muted-foreground">No executions yet.</div>
        )}
        <AlertDialog
          open={confirmId !== null}
          onOpenChange={(o) => {
            if (!o) setConfirmId(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete execution {confirmId}?</AlertDialogTitle>
              <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
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
      </PageBody>
    </Page>
  );
}
