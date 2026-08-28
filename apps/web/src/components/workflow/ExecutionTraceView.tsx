"use client";

import type { AskQuestionInput } from "@chengchenccc/agent-contract";
import { toEditorGraph, type WorkflowDefinition } from "@chengchenccc/workflow";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { api } from "@/lib/api";
import { AskQuestionCard } from "./AskQuestionCard";
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
    const map: Record<string, NodeStatus> = {};
    for (const n of graph.nodes)
      map[n.id] = done.has(n.id) ? "done" : n.id === active ? "active" : "idle";
    return map;
  }, [index, events, graph]);

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

  return (
    <div className="flex h-full">
      <div className="flex-1 border-r">
        <WorkflowCanvas graph={graph} nodeStatus={nodeStatus} litEdges={litEdges} />
      </div>
      <div className="w-80 border-l">
        <div className="flex items-center gap-2 border-b p-3">
          <Link
            href={`/agentic-workflow/${execution.workflowId}/executions`}
            className="text-xs text-(--info) hover:text-(--primary)"
          >
            ← executions
          </Link>
          <button className="rounded border px-2" onClick={() => setIndex(Math.max(0, index - 1))}>
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
        {execution.status === "waiting_human" && pendingHuman && (
          <div className="border-b p-3">
            <AskQuestionCard
              input={(pendingHuman.form?.questions as AskQuestionInput) ?? { questions: [] }}
              onSubmit={async (result) => {
                await api.resolveWorkflowHumanTask(execution.executionId, {
                  nodeId: pendingHuman.nodeId,
                  answer: { answers: result.answers } as unknown as Record<string, unknown>,
                });
                router.refresh();
              }}
            />
          </div>
        )}
        <div className="max-h-[40vh] overflow-auto p-3 text-xs">
          <div className="mb-1 font-semibold">Event log</div>
          {events.slice(0, index + 1).map((e) => (
            <div key={e.seq} className="border-b py-1">
              <span className="text-muted-foreground">{new Date(e.ts).toLocaleTimeString()}</span>{" "}
              {e.event}
            </div>
          ))}
        </div>
        <div className="border-t p-3 text-xs">
          <div className="mb-1 font-semibold">Store snapshot</div>
          <pre className="max-h-[20vh] overflow-auto text-[10px]">
            {JSON.stringify(snapshot, null, 2)}
          </pre>
        </div>
        <div className="border-t p-3 text-xs">
          <div className="mb-1 font-semibold">Node runs</div>
          {nodeRuns.map((r) => (
            <div key={r.seq} className="flex justify-between border-b py-0.5">
              <span>{r.nodeId}</span>
              <span>{r.status}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
