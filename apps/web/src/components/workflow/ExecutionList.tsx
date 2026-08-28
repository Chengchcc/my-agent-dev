"use client";

import Link from "next/link";
import { useState } from "react";
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
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";

type Exec = {
  executionId: string;
  status: string;
  exit?: string;
  error?: string;
  createdAt: number;
  terminalAt?: number;
};

export function ExecutionList({
  workflowId,
  executions,
  definition,
}: {
  workflowId: string;
  executions: Exec[];
  definition?: { input?: Record<string, "string" | "number" | "boolean"> } | null;
}) {
  const [inputVals, setInputVals] = useState<Record<string, string>>({});
  const [runOpen, setRunOpen] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const inputHints = definition?.input ?? {};

  async function run() {
    const input: Record<string, unknown> = {};
    for (const [key, hint] of Object.entries(inputHints)) {
      const raw = inputVals[key] ?? "";
      if (raw === "") continue;
      if (hint === "number") input[key] = Number(raw);
      else if (hint === "boolean") input[key] = raw === "true";
      else input[key] = raw;
    }
    try {
      await api.startWorkflowExecution({
        workflowRef: { repo: "local", path: `${workflowId}.workflow.json` },
        input,
      });
      window.location.reload();
    } catch (err) {
      alert(`Run failed: ${(err as Error).message}`);
    }
  }

  async function del(executionId: string) {
    try {
      await api.deleteWorkflowExecution(executionId);
      window.location.reload();
    } catch (err) {
      alert(`Delete failed: ${(err as Error).message}`);
    }
  }
  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/agentic-workflow">Workflows</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink href={`/agentic-workflow/${workflowId}`}>{workflowId}</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Executions</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <Dialog open={runOpen} onOpenChange={setRunOpen}>
          <button
            className="rounded-md bg-(--primary) px-3 py-1.5 text-xs text-(--ink) transition-colors hover:bg-(--panel2)"
            onClick={() => setRunOpen(true)}
          >
            + Run
          </button>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="text-sm font-semibold">运行 {workflowId}</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              {Object.keys(inputHints).length === 0 ? (
                <p className="text-xs text-(--mute)">该 workflow 无输入参数。</p>
              ) : (
                Object.entries(inputHints).map(([key, hint]) => (
                  <div key={key} className="flex flex-col gap-1">
                    <Label className="text-xs text-(--mute)">
                      {key} <span className="text-(--faint)">({hint})</span>
                    </Label>
                    <Input
                      className="h-9 border-(--hairline) bg-(--canvas) text-xs"
                      type={hint === "number" ? "number" : hint === "boolean" ? "text" : "text"}
                      placeholder={hint === "boolean" ? "true / false" : ""}
                      value={inputVals[key] ?? ""}
                      onChange={(e) => setInputVals((v) => ({ ...v, [key]: e.target.value }))}
                    />
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
      </div>
      <div className="space-y-2">
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
                    {e.status === "waiting_human" ? "等待确认" : e.status}
                  </span>
                  {dur !== undefined && <span className="text-[10px] text-(--mute)">{dur}s</span>}
                </div>
                <Link
                  href={`/agentic-workflow/${workflowId}/executions/${e.executionId}`}
                  className="mt-1 block truncate text-sm font-medium text-(--ink) hover:text-(--primary)"
                >
                  {new Date(e.createdAt).toLocaleString()}
                </Link>
              </div>
              {e.status === "failure" && e.error && (
                <div className="min-w-0 flex-1 truncate text-xs text-(--err)" title={e.error}>
                  {e.error}
                </div>
              )}
              <div className="flex shrink-0 items-center gap-2">
                <Link
                  href={`/agentic-workflow/${workflowId}/executions/${e.executionId}`}
                  className="rounded-md border border-(--hairline) px-2.5 py-1 text-xs text-(--info) hover:bg-(--panel2)"
                >
                  查看
                </Link>
                <button
                  className="rounded-md px-2 py-1 text-xs text-(--err) hover:bg-(--err)/10"
                  onClick={() => setConfirmId(e.executionId)}
                >
                  删除
                </button>
              </div>
            </div>
          );
        })}
      </div>
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
            <AlertDialogDescription>此操作不可撤销。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmId) void del(confirmId);
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
