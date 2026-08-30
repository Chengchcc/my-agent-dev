"use client";

import { toEditorGraph, type WorkflowDefinition } from "@chengchenccc/workflow";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { api } from "@/lib/api";
import { type NodeStatus, WorkflowCanvas } from "./WorkflowCanvas";

export type TraceEvent = { seq: number; event: string; data: unknown; ts: number };
export type TraceNodeRun = {
  seq: number;
  nodeId: string;
  status: string;
  output?: Record<string, unknown>;
  routedTo?: string[];
};
export type TraceExecution = {
  executionId: string;
  workflowId: string;
  definition: WorkflowDefinition;
  input: Record<string, unknown>;
  store: Record<string, unknown>;
  status: string;
  exit?: string;
  error?: string;
  createdAt: number;
};

function replayStore(events: TraceEvent[], upto: number): Record<string, unknown> {
  const store: Record<string, unknown> = {};
  for (let i = 0; i <= upto; i++) {
    const e = events[i]!;
    if (e.event === "store_write") {
      const d = e.data as { key: string; value?: unknown; deleted?: boolean };
      if (d.deleted) delete store[d.key];
      else store[d.key] = d.value;
    }
  }
  return store;
}

export function ExecutionTraceView({
  execution,
  events,
  nodeRuns,
  pendingHuman,
}: {
  execution: TraceExecution;
  events: TraceEvent[];
  nodeRuns: TraceNodeRun[];
  pendingHuman?: {
    nodeId: string;
    question?: string;
    form?: Record<string, unknown>;
    status: string;
  } | null;
}) {
  const router = useRouter();
  const [index, setIndex] = useState(Math.max(0, events.length - 1));
  const [expandedEvent, setExpandedEvent] = useState<number | null>(null);
  const [upstreamArtifacts, setUpstreamArtifacts] = useState<
    Array<{ url: string; from: string; content?: string }>
  >([]);
  const graph = useMemo(() => toEditorGraph(execution.definition), [execution.definition]);

  const nodeStatus = useMemo(() => {
    const done = new Set<string>();
    let active: string | undefined;
    for (let i = 0; i <= Math.min(index, events.length - 1); i++) {
      const e = events[i]!;
      if (e.event === "node_completed") done.add((e.data as { nodeId: string }).nodeId);
      if (e.event === "node_started") active = (e.data as { nodeId: string }).nodeId;
    }
    if (active && done.has(active)) active = undefined;
    const failed = new Set(nodeRuns.filter((r) => r.status === "failed").map((r) => r.nodeId));
    const map: Record<string, NodeStatus> = {};
    for (const n of graph.nodes)
      map[n.id] = failed.has(n.id)
        ? "failed"
        : done.has(n.id)
          ? "done"
          : n.id === active
            ? "active"
            : "idle";
    return map;
  }, [index, events, graph, nodeRuns]);

  const litEdges = useMemo(() => {
    const lit = new Set<string>();
    for (let i = 0; i <= Math.min(index, events.length - 1); i++) {
      const e = events[i]!;
      if (e.event === "node_completed") {
        const d = e.data as { nodeId: string; routedTo?: string[] };
        for (const to of d.routedTo ?? []) lit.add(`${d.nodeId}->${to}`);
      }
    }
    return lit;
  }, [index, events]);

  const snapshot = useMemo(() => replayStore(events, index), [events, index]);

  // Approval context: artifacts produced by completed nodes (values that are
  // artifacts:// URLs), fetched so the human can read them before deciding.
  useEffect(() => {
    const found: Array<{ url: string; from: string }> = [];
    for (const r of nodeRuns) {
      if (r.status !== "completed") continue;
      for (const v of Object.values(r.output ?? {})) {
        if (typeof v === "string" && v.startsWith("artifacts://")) {
          found.push({ url: v, from: r.nodeId });
        }
      }
    }
    let stopped = false;
    void (async () => {
      const withContent = await Promise.all(
        found.map(async (f) => {
          try {
            const d = await api.downloadArtifact(f.url);
            return { ...f, content: d.encoding === "utf8" ? d.content : undefined };
          } catch {
            return f;
          }
        }),
      );
      if (!stopped) setUpstreamArtifacts(withContent);
    })();
    return () => {
      stopped = true;
    };
  }, [nodeRuns]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-(--hairline) px-4">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/agentic-workflow">Workflows</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink href={`/agentic-workflow/${execution.workflowId}`}>
                {execution.workflowId}
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink href={`/agentic-workflow/${execution.workflowId}/executions`}>
                Executions
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{execution.executionId.slice(0, 16)}…</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <span className="ml-auto font-mono text-[10px] text-(--mute)">{execution.status}</span>
      </div>
      {execution.status === "failure" && execution.error && (
        <div className="shrink-0 border-b border-(--err)/20 bg-(--err)/10 px-4 py-2 text-xs text-(--err)">
          <span className="font-semibold">执行失败：</span>
          {execution.error}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="flex-1 border-r">
          <WorkflowCanvas
            graph={graph}
            nodeStatus={nodeStatus}
            litEdges={litEdges}
            pendingHuman={pendingHuman ?? null}
            upstreamArtifacts={upstreamArtifacts}
            onSubmitHuman={async (nodeId, answer) => {
              if (!pendingHuman) return;
              await api.resolveWorkflowHumanTask(execution.executionId, {
                nodeId,
                answer,
              });
              router.refresh();
            }}
          />
        </div>
        <div className="w-80 border-l">
          <div className="flex items-center gap-2 border-b p-3">
            <Link
              href={`/agentic-workflow/${execution.workflowId}/executions`}
              className="text-xs text-(--info) hover:text-(--primary)"
            >
              ← executions
            </Link>
            <button
              className="rounded border px-2"
              onClick={() => setIndex(Math.max(0, index - 1))}
            >
              ◀
            </button>
            <input
              type="range"
              min={0}
              max={Math.max(0, events.length - 1)}
              value={index}
              onChange={(e) => setIndex(Number(e.target.value))}
              className="flex-1"
            />
            <button
              className="rounded border px-2"
              onClick={() => setIndex(Math.min(events.length - 1, index + 1))}
            >
              ▶
            </button>
            <span className="text-xs text-muted-foreground">
              {index + 1}/{events.length}
            </span>
          </div>
          <div className="border-t p-3 text-xs">
            <Collapsible>
              <CollapsibleTrigger className="flex w-full items-center justify-between text-(--mute) hover:text-(--ink)">
                <span className="font-semibold">调试</span>
                <span className="text-[10px]">展开</span>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-3 pt-2">
                <div>
                  <div className="mb-1 font-semibold">Event log</div>
                  {events.slice(0, index + 1).map((e) => (
                    <div key={e.seq} className="border-b py-1">
                      <button
                        className="flex w-full items-center gap-1 text-left"
                        onClick={() => setExpandedEvent(expandedEvent === e.seq ? null : e.seq)}
                      >
                        <span className="text-muted-foreground">
                          {new Date(e.ts).toLocaleTimeString()}
                        </span>{" "}
                        {e.event}
                      </button>
                      {expandedEvent === e.seq && (
                        <pre className="mt-1 max-h-48 overflow-auto rounded bg-(--canvas)/60 p-2 text-[10px] text-(--mute)">
                          {JSON.stringify(e.data, null, 2)}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
                <div>
                  <div className="mb-1 font-semibold">Store snapshot</div>
                  <pre className="max-h-[20vh] overflow-auto text-[10px]">
                    {JSON.stringify(snapshot, null, 2)}
                  </pre>
                </div>
                <div>
                  <div className="mb-1 font-semibold">Node runs</div>
                  {nodeRuns.map((r) => (
                    <div key={r.seq} className="flex justify-between border-b py-0.5">
                      <span>{r.nodeId}</span>
                      <span>{r.status}</span>
                    </div>
                  ))}
                </div>
                {graph.nodes.filter((n) => n.type === "agent").length > 0 && (
                  <div>
                    <div className="mb-1 font-semibold">Agent conversations</div>
                    {graph.nodes
                      .filter((n) => n.type === "agent")
                      .map((n) => (
                        <Link
                          key={n.id}
                          href={`/chat/workflow:${execution.executionId}:${n.id}`}
                          className="flex items-center justify-between border-b py-1 text-(--info) hover:text-(--primary)"
                        >
                          <span>{n.label}</span>
                          <span>查看 →</span>
                        </Link>
                      ))}
                  </div>
                )}
              </CollapsibleContent>
            </Collapsible>
          </div>
        </div>
      </div>
    </div>
  );
}
