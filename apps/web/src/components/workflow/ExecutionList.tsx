"use client";

import Link from "next/link";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

import { api } from "@/lib/api";

type Exec = { executionId: string; status: string; exit?: string; createdAt: number };

export function ExecutionList({
  workflowId,
  executions,
}: {
  workflowId: string;
  executions: Exec[];
}) {
  async function run() {
    const input = prompt("Trigger input JSON (optional):") ?? "{}";
    try {
      await api.startWorkflowExecution({
        workflowRef: { repo: "local", path: `${workflowId}.workflow.json` },
        input: JSON.parse(input),
      });
      window.location.reload();
    } catch (err) {
      alert(`Run failed: ${(err as Error).message}`);
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
        <button
          className="rounded-md bg-(--primary) px-3 py-1.5 text-xs text-(--ink) transition-colors hover:bg-(--panel2)"
          onClick={run}
        >
          + Run
        </button>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th>executionId</th>
            <th>status</th>
            <th>exit</th>
            <th>createdAt</th>
          </tr>
        </thead>
        <tbody>
          {executions.map((e) => (
            <tr key={e.executionId} className="border-t">
              <td className="py-2">
                <Link
                  href={`/agentic-workflow/${workflowId}/executions/${e.executionId}`}
                  className="hover:underline"
                >
                  {e.executionId}
                </Link>
              </td>
              <td>{e.status}</td>
              <td>{e.exit ?? "-"}</td>
              <td>{new Date(e.createdAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {executions.length === 0 && (
        <div className="mt-4 text-sm text-muted-foreground">No executions yet.</div>
      )}
    </div>
  );
}
