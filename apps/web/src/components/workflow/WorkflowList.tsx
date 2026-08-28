"use client";

import Link from "next/link";
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
  async function create() {
    const id = `wf-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await api.saveWorkflowDefinition(id, defaultDraft(id) as Record<string, unknown>);
    window.location.assign(`/agentic-workflow/${id}`);
  }
  async function del(id: string) {
    if (!confirm(`Delete workflow ${id}?`)) return;
    await api.deleteWorkflowDefinition(id);
    window.location.reload();
  }
  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Agentic Workflow</h1>
        <button className="rounded bg-slate-800 px-3 py-1 text-white" onClick={create}>
          + New
        </button>
      </div>
      <div className="space-y-2">
        {definitions.map((d) => (
          <div
            key={d.workflowId}
            className="flex items-center justify-between rounded-lg border p-3"
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
                  <span key={t} className="rounded bg-slate-100 px-1 py-0.5 text-[10px]">
                    {t}
                  </span>
                ))}
                {d.status && (
                  <span className="rounded bg-slate-100 px-1 py-0.5 text-[10px]">{d.status}</span>
                )}
              </div>
            </div>
            <div className="flex shrink-0 gap-2 text-xs">
              <Link
                href={`/agentic-workflow/${d.workflowId}/executions`}
                className="text-blue-600 hover:underline"
              >
                executions
              </Link>
              <button className="text-red-600 hover:underline" onClick={() => del(d.workflowId)}>
                delete
              </button>
            </div>
          </div>
        ))}
        {definitions.length === 0 && (
          <div className="text-sm text-muted-foreground">No workflows yet.</div>
        )}
      </div>
    </div>
  );
}
