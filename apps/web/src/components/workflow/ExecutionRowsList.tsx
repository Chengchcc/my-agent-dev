"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
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
import { api } from "@/lib/api";
import { humanizeWorkflowError } from "./humanize-error";

export type WorkflowExec = {
  executionId: string;
  triggeredBy?: string | null;
  status: string;
  exit?: string;
  error?: string;
  createdAt: number;
  terminalAt?: number;
};

function useLiveExecutions(workflowId: string, initial: WorkflowExec[]): WorkflowExec[] {
  const [rows, setRows] = useState<WorkflowExec[]>(initial);
  useEffect(() => {
    setRows(initial);
  }, [initial]);
  const anyRunning = rows.some((r) => r.status === "running" || r.status === "waiting_human");
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => {
      api
        .listWorkflowExecutions(workflowId)
        .then((r) => setRows((r?.executions ?? []) as WorkflowExec[]))
        .catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [anyRunning, workflowId]);
  return rows;
}

/** Shared execution log: rows + live poll + delete confirm. Used by the
 *  ExecutionList page and the list sheet — no Page/chrome, just the rows. */
export function ExecutionRowsList({
  workflowId,
  executions: initialExecutions,
  onMutated,
}: {
  workflowId: string;
  executions: WorkflowExec[];
  onMutated?: () => void;
}) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const executions = useLiveExecutions(workflowId, initialExecutions);

  async function del(executionId: string) {
    try {
      await api.deleteWorkflowExecution(executionId);
      onMutated?.();
    } catch (err) {
      toast.error(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <>
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
                {new Date(e.createdAt).toLocaleString("en-US")}
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
              <Button variant="destructive" size="sm" onClick={() => setConfirmId(e.executionId)}>
                Delete
              </Button>
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
    </>
  );
}
