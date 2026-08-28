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
  async function create() {
    const id = `wf-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await api.saveWorkflowDefinition(id, defaultDraft(id) as Record<string, unknown>);
    window.location.assign(`/agentic-workflow/${id}`);
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
            </div>
            <div className="flex shrink-0 gap-2 text-xs">
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
