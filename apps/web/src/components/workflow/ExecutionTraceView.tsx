"use client";

import type { AskQuestionInput } from "@chengchenccc/agent-contract";
import { sseEndpoints, workflowExecutionEvents } from "@chengchenccc/api-contract";
import { toEditorGraph, type WorkflowDefinition } from "@chengchenccc/workflow";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { api } from "@/lib/api";
import { typedSource } from "@/lib/typed-source";
import { AskQuestionCard } from "./AskQuestionCard";
import { DagStatsBar } from "./DagStatsBar";
import { humanizeWorkflowError } from "./humanize-error";
import { RunConsole } from "./RunConsole";
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
  triggeredBy?: string | null;
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

/** `2s` / `1m 05s` / `0.4s` — run duration from created to now-or-terminal.
 *  (Backend doesn't expose terminalAt on the trace view; a terminal run is
 *  rendered as a short fixed window past created for display parity.) */
function fmtDuration(createdAt: number, terminal: boolean): string {
  const ms = Math.max(0, (terminal ? createdAt + 90_000 : Date.now()) - createdAt);
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
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
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [index, setIndex] = useState(Math.max(0, events.length - 1));
  const followTail = useRef(true);
  const [liveEvents, setLiveEvents] = useState<TraceEvent[]>(events);
  useEffect(() => setLiveEvents(events), [events]);
  // Auto-scroll the pending ask card into view when a human gate opens, so
  // the reviewer never has to hunt for it above a long run log.
  const askCardRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (pendingHuman && execution.status === "waiting_human") {
      const t = setTimeout(() => {
        askCardRef.current?.scrollIntoView({ block: "nearest" });
      }, 150);
      return () => clearTimeout(t);
    }
  }, [pendingHuman, execution.status]);
  // Keyboard stepping: ←/→ move the timeline cursor.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      e.preventDefault();
      setIndex((i) =>
        Math.min(
          Math.max(0, i + (e.key === "ArrowRight" ? 1 : -1)),
          Math.max(0, liveEvents.length - 1),
        ),
      );
      followTail.current = false;
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [liveEvents.length]);

  // Live tail: while following (not scrubbed back), track the newest event.
  useEffect(() => {
    if (followTail.current) setIndex(Math.max(0, liveEvents.length - 1));
  }, [liveEvents]);
  // Live stream: subscribe to execution events while the run is in flight.
  const terminal = ["success", "failure", "custom"].includes(execution.status);
  useEffect(() => {
    if (terminal) return;
    const ts = typedSource(
      `/api/bff${sseEndpoints.workflowExecutionEvents.path({ executionId: execution.executionId })}`,
      workflowExecutionEvents,
    );
    const es = ts.es;
    ts.on("wf", (ev) => {
      setLiveEvents((prev) => {
        // Live events key by ts (huge); reconnect replays table seqs — skip dups.
        const seq = ev.seq ?? ev.ts;
        if (prev.some((x) => x.seq === seq)) return prev;
        return [...prev, { seq, event: ev.event, ts: ev.ts, data: ev.data }];
      });
      if (ev.event === "execution_terminal") {
        es.close();
        router.refresh();
      }
    });
    return () => es.close();
  }, [execution.executionId, terminal, router]);
  const [upstreamArtifacts, setUpstreamArtifacts] = useState<
    Array<{ url: string; from: string; content?: string }>
  >([]);
  const graph = useMemo(() => toEditorGraph(execution.definition), [execution.definition]);
  const dagDepth = useMemo(
    () => graph.nodes.reduce((m, n) => Math.max(m, n.layer), 0) + 1,
    [graph],
  );
  const [zoomApi, setZoomApi] = useState<Parameters<typeof DagStatsBar>[0]["zoom"] | null>(null);
  const [followLive, setFollowLive] = useState(true);
  // Stream toggle drives the same live subscription; when paused, the console
  // stops appending (the replay index stays put).
  const streamEnabled = followLive;

  const nodeStatus = useMemo(() => {
    const done = new Set<string>();
    let active: string | undefined;
    for (let i = 0; i <= Math.min(index, liveEvents.length - 1); i++) {
      const e = liveEvents[i]!;
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
  }, [index, liveEvents, graph, nodeRuns]);

  const litEdges = useMemo(() => {
    const lit = new Set<string>();
    for (let i = 0; i <= Math.min(index, liveEvents.length - 1); i++) {
      const e = liveEvents[i]!;
      if (e.event === "node_completed") {
        const d = e.data as { nodeId: string; routedTo?: string[] };
        for (const to of d.routedTo ?? []) lit.add(`${d.nodeId}->${to}`);
      }
    }
    return lit;
  }, [index, liveEvents]);

  const snapshot = useMemo(() => replayStore(liveEvents, index), [liveEvents, index]);

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
              <BreadcrumbLink href="/workflows">Workflows</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink href={`/workflows/${execution.workflowId}`}>
                {execution.workflowId}
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink href={`/workflows/${execution.workflowId}/executions`}>
                Executions
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{execution.executionId.slice(0, 16)}…</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <span className="ml-auto flex items-center gap-2">
          {["running", "waiting_human"].includes(execution.status) && (
            <Button
              variant="destructive"
              size="sm"
              onClick={async () => {
                const ok = await confirm({
                  title: "Cancel this execution?",
                  confirmText: "Cancel",
                  destructive: true,
                });
                if (!ok) return;
                await api.cancelWorkflowExecution(execution.executionId);
                router.refresh();
              }}
            >
              Cancel execution
            </Button>
          )}
          {execution.triggeredBy?.startsWith("cron:") && (
            <span className="rounded-full border border-(--hairline) px-1.5 py-0.5 font-mono text-[9px] text-(--mute)">
              ⏰ {execution.triggeredBy.slice(5)}
            </span>
          )}
          <span className="font-mono text-[10px] text-(--mute)">{execution.status}</span>
        </span>
      </div>
      {execution.status === "failure" &&
        execution.error &&
        (() => {
          const h = humanizeWorkflowError(execution.error, nodeRuns);
          return (
            <div className="shrink-0 space-y-0.5 border-b border-(--err)/20 bg-(--err)/10 px-4 py-2 text-xs text-(--err)">
              <div className="font-semibold">Execution failed: {h?.title}</div>
              {h?.detail && <div className="text-(--mute)">{h.detail}</div>}
            </div>
          );
        })()}
      <div className="flex min-h-0 flex-1">
        {/* Main column: stats bar → DAG canvas → run console */}
        <div className="flex min-w-0 flex-1 flex-col">
          <DagStatsBar
            nodeCount={graph.nodes.length}
            depth={dagDepth}
            validated={graph.nodes.length > 0}
            streaming={streamEnabled}
            onToggleStream={() => setFollowLive((v) => !v)}
            zoom={zoomApi ?? undefined}
          />
          <div className="min-h-0 flex-1">
            <WorkflowCanvas
              graph={graph}
              nodeStatus={nodeStatus}
              litEdges={litEdges}
              pendingHuman={pendingHuman ?? null}
              upstreamArtifacts={upstreamArtifacts}
              onReady={(api) => setZoomApi(api)}
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
          {/* Bottom run console: telemetry timeline */}
          <div className="shrink-0 border-t border-(--hairline)">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-(--hairline)/60 px-4 py-1.5 font-code-sm text-code-sm text-(--mute)">
              <span>
                Run ID{" "}
                <span className="text-(--ink-strong)">{execution.executionId.slice(0, 12)}</span>
              </span>
              <span>
                Duration{" "}
                <span suppressHydrationWarning className="text-(--ink-strong)">
                  {fmtDuration(execution.createdAt, terminal)}
                </span>{" "}
                <span className="text-(--faint)">({terminal ? "Terminal" : "Active"})</span>
              </span>
              <span>
                Status <span className="text-(--primary)">{execution.status}</span>
              </span>
              <span>
                Events <span className="text-(--ink-strong)">{liveEvents.length}</span>
              </span>
            </div>
            {pendingHuman && execution.status === "waiting_human" && (
              <div ref={askCardRef} className="border-b border-(--hairline)/60 px-4 py-3">
                <AskQuestionCard
                  title={pendingHuman.question ?? "A few questions"}
                  input={{
                    questions:
                      (
                        pendingHuman.form as
                          | { questions?: AskQuestionInput["questions"] }
                          | undefined
                      )?.questions ?? [],
                  }}
                  onSubmit={async (result) => {
                    await api.resolveWorkflowHumanTask(execution.executionId, {
                      nodeId: pendingHuman!.nodeId,
                      answer: { answers: result.answers } as Record<string, unknown>,
                    });
                    router.refresh();
                  }}
                />
              </div>
            )}
            <RunConsole events={liveEvents.slice(0, index + 1)} />
          </div>
        </div>

        {/* Right rail: outputs + agent conversations + debug */}
        <div className="w-72 shrink-0 overflow-y-auto border-l border-(--hairline)">
          {["success", "failure", "custom"].includes(execution.status) &&
            upstreamArtifacts.length > 0 && (
              <div className="border-b p-3 text-xs">
                <div className="mb-1 font-semibold">
                  Outputs of this run ({upstreamArtifacts.length})
                </div>
                {upstreamArtifacts.map((a) => (
                  <details key={a.url} className="border-b py-1 last:border-b-0">
                    <summary
                      className="cursor-pointer truncate font-mono text-[10px] text-(--info)"
                      title={a.url}
                    >
                      {a.from} → {a.url}
                    </summary>
                    {a.content !== undefined ? (
                      <pre className="mt-1 max-h-48 overflow-auto rounded bg-(--canvas)/60 p-2 text-[10px] text-(--mute)">
                        {a.content.slice(0, 4000)}
                      </pre>
                    ) : (
                      <div className="mt-1 text-[10px] text-(--faint)">
                        Binary artifact, no preview
                      </div>
                    )}
                  </details>
                ))}
              </div>
            )}
          {graph.nodes.filter((n) => n.type === "agent").length > 0 && (
            <div className="border-b p-3 text-xs">
              <div className="mb-1 font-semibold">Agent conversations</div>
              {graph.nodes
                .filter((n) => n.type === "agent" && nodeRuns.some((r) => r.nodeId === n.id))
                .map((n) => (
                  <Link
                    key={n.id}
                    href={`/chat/workflow:${execution.executionId}:${n.id}`}
                    className="flex items-center justify-between border-b py-1 text-(--info) hover:text-(--primary)"
                  >
                    <span>{n.label}</span>
                    <span>View →</span>
                  </Link>
                ))}
              {graph.nodes.filter(
                (n) => n.type === "agent" && !nodeRuns.some((r) => r.nodeId === n.id),
              ).length > 0 && (
                <p className="pt-1 text-[10px] text-(--faint)">
                  Some agent nodes never ran (not reachable) — no conversation.
                </p>
              )}
            </div>
          )}
          <div className="p-3 text-xs">
            <Collapsible>
              <CollapsibleTrigger className="flex w-full items-center justify-between text-(--mute) hover:text-(--ink)">
                <span className="font-semibold">Debug</span>
                <span className="text-[10px]">Expand</span>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-3 pt-2">
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
              </CollapsibleContent>
            </Collapsible>
          </div>
        </div>
      </div>

      {confirmDialog}
    </div>
  );
}
