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
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [runDef, setRunDef] = useState<{
    input?: Record<string, "string" | "number" | "boolean">;
  } | null>(null);
  const [runVals, setRunVals] = useState<Record<string, string>>({});
  async function create() {
    const id = `wf-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await api.saveWorkflowDefinition(id, defaultDraft(id) as Record<string, unknown>);
    window.location.assign(`/agentic-workflow/${id}`);
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
    if (!runId) return;
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
      window.location.assign(`/agentic-workflow/${runId}/executions`);
    } catch (err) {
      alert(`Run failed: ${(err as Error).message}`);
    }
  }
  async function del(id: string) {
    await api.deleteWorkflowDefinition(id);
    window.location.reload();
  }
  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Agentic Workflow</h1>
        <button
          className="rounded-md bg-(--primary) px-3 py-1.5 text-xs text-(--ink) transition-colors hover:bg-(--panel2)"
          onClick={create}
        >
          + New
        </button>
      </div>
      <div className="space-y-2">
        {definitions.map((d) => (
          <div
            key={d.workflowId}
            className="flex items-center justify-between rounded-xl border border-(--hairline) bg-(--panel)/70 p-3"
          >
            <div>
              <Link
                href={`/agentic-workflow/${d.workflowId}`}
                className="font-medium hover:underline"
              >
                {d.name ?? d.workflowId}
              </Link>
              {d.description && (
                <div className="text-xs text-muted-foreground">{d.description}</div>
              )}
              <div className="mt-1 flex flex-wrap gap-1">
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
                      ? "等待确认"
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
              <button
                className="rounded-md border border-(--primary)/40 bg-(--primary)/10 px-2 py-1 text-(--primary) transition-colors hover:bg-(--primary)/20"
                onClick={() => openRun(d.workflowId)}
              >
                Run
              </button>
              <Link
                href={`/agentic-workflow/${d.workflowId}/executions`}
                className="rounded-md border border-(--hairline) px-2 py-1 text-(--info) transition-colors hover:bg-(--panel2)"
              >
                executions
              </Link>
              <button
                className="text-red-600 hover:underline"
                onClick={() => setConfirmId(d.workflowId)}
              >
                delete
              </button>
            </div>
          </div>
        ))}
        {definitions.length === 0 && (
          <div className="text-sm text-muted-foreground">No workflows yet.</div>
        )}
      </div>
      <Dialog
        open={runId !== null}
        onOpenChange={(o) => {
          if (!o) setRunId(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold">运行 {runId}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {Object.keys(runDef?.input ?? {}).length === 0 ? (
              <p className="text-xs text-(--mute)">该 workflow 无输入参数。</p>
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
            <button
              className="w-full rounded-md bg-(--primary) px-3 py-2 text-xs text-(--ink) hover:bg-(--panel2)"
              onClick={run}
            >
              运行
            </button>
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
