"use client";

import { conversationEvents, runEvents, sseEndpoints } from "@chengchenccc/api-contract";
import { parseMessageRevision } from "@chengchenccc/message";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { toast } from "sonner";
import type { ChatModelOverride } from "@/components/ModelPicker";
import {
  useConversationSnapshot,
  usePostConversationMessage,
} from "@/features/conversations/hooks";
import type { ConversationSnapshot } from "@/lib/api";
import { api } from "@/lib/api";
import { initialState, isBusy, reducer } from "@/lib/conversation-reducer";
import {
  appendThinking,
  appendTransient,
  clearRunTodos,
  clearRunTools,
  clearTransientApproval,
  completeTool,
  type LiveToolCall,
  type LiveToolMap,
  markTransientError,
  pushTransientNotice,
  type RunTodoMap,
  removeTransient,
  setRunTodos as setRunTodosMap,
  setTransientApproval,
  type TodoItem,
  type TransientMap,
  upsertTool,
} from "@/lib/transient-reducer";
import { typedSource } from "@/lib/typed-source";

/** Transient workflow run progress (SSE-driven; cleared on stream close). */
export interface WorkflowAgentState {
  readonly label: string;
  readonly status: "running" | "done" | "failed";
  readonly error?: string;
}
export interface WorkflowRunState {
  readonly label: string;
  readonly agentCount: number;
  readonly agents: ReadonlyMap<string, WorkflowAgentState>;
  readonly ok: boolean | null;
  readonly totalTokens: number;
}

export function useConversation(
  conversationId: string,
  preFetchedSnapshot?: ConversationSnapshot | null,
) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  /** Transient Agent Run state (Live Updates): a set of active runIds.
   *  Runs are removed when their terminal state is observed on the run
   *  event stream OR when the canonical final Message lands in History. */
  const [activeRuns, setActiveRuns] = useState<Set<string>>(new Set());
  /** Transient streaming output per active run (one bubble per run in the
   *  Timeline). Never persisted; each entry is replaced by the canonical
   *  final Message (`run:<runId>:assistant:0`) or dropped on failure. */
  const [transients, setTransients] = useState<TransientMap>({});
  const runStreamsRef = useRef(new Map<string, EventSource>());
  const transientsRef = useRef(transients);

  /** Live tool steps per run (`<runId>:<callId>` key). Run-local, transient:
   *  never written to History, cleared at run terminal. */
  const [transientTools, setTransientTools] = useState<LiveToolMap>({});
  /** Latest todo snapshot per run (todo_write replaces the whole list). */
  const [runTodos, setRunTodos] = useState<RunTodoMap>({});
  /** Live workflow runs (transient progress, cleared with the SSE stream). */
  const [workflows, setWorkflows] = useState<ReadonlyMap<string, WorkflowRunState>>(new Map());

  const upsertToolState = useCallback((call: LiveToolCall) => {
    setTransientTools((prev) => upsertTool(prev, call));
  }, []);
  const completeToolState = useCallback(
    (runId: string, callId: string, result: unknown, isError: boolean) => {
      setTransientTools((prev) => completeTool(prev, runId, callId, result, isError));
    },
    [],
  );
  const clearRunToolsState = useCallback((runId: string) => {
    setTransientTools((prev) => clearRunTools(prev, runId));
  }, []);
  const setRunTodosState = useCallback((runId: string, items: readonly TodoItem[]) => {
    setRunTodos((prev) => setRunTodosMap(prev, runId, items));
  }, []);
  const clearRunTodosState = useCallback((runId: string) => {
    setRunTodos((prev) => clearRunTodos(prev, runId));
  }, []);

  // Leaving the conversation closes every run EventSource and clears all
  // transient state — a switched conversation must never inherit the
  // previous one's streaming bubbles. Runs on unmount AND conversationId
  // change; setState calls after unmount are no-ops in React 18+.
  // biome-ignore lint/correctness/useExhaustiveDependencies: cleanup-only effect keyed on conversationId
  useEffect(() => {
    return () => {
      for (const es of runStreamsRef.current.values()) es.close();
      runStreamsRef.current.clear();
      setActiveRuns(new Set());
      setTransients({});
      transientsRef.current = {};
      setTransientTools({});
      setRunTodos({});
      setWorkflows(new Map());
    };
  }, [conversationId]);
  const upsertTransient = useCallback((runId: string, agentId: string, text: string) => {
    setTransients((prev) => {
      const next = appendTransient(prev, runId, agentId, text);
      transientsRef.current = next;
      return next;
    });
  }, []);
  const upsertThinking = useCallback((runId: string, agentId: string, text: string) => {
    setTransients((prev) => {
      const next = appendThinking(prev, runId, agentId, text);
      transientsRef.current = next;
      return next;
    });
  }, []);
  const dropTransient = useCallback((runId: string) => {
    setTransients((prev) => {
      const next = removeTransient(prev, runId);
      transientsRef.current = next;
      return next;
    });
  }, []);
  /** HITL approval (spec): POST the decision, then clear the pending card. */
  const resolveApproval = useCallback(
    async (runId: string, callId: string, decision: "allow" | "deny") => {
      await api.resolveApproval(runId, callId, decision).catch((err: unknown) => {
        console.error("approval resolve failed:", err);
      });
      setTransients((prev) => {
        const next = clearTransientApproval(prev, runId);
        transientsRef.current = next;
        return next;
      });
    },
    [],
  );
  const failTransient = useCallback((runId: string, agentId: string, error: string) => {
    setTransients((prev) => {
      const next = markTransientError(prev, runId, agentId, error);
      transientsRef.current = next;
      return next;
    });
  }, []);
  const pushRunNotice = useCallback((runId: string, agentId: string, notice: string) => {
    setTransients((prev) => {
      const next = pushTransientNotice(prev, runId, agentId, notice);
      transientsRef.current = next;
      return next;
    });
  }, []);
  // 1) Snapshot bootstrap (the conversation's agent)
  const snap = useConversationSnapshot(conversationId, preFetchedSnapshot);
  useEffect(() => {
    if (!snap.data) return;
    dispatch({
      type: "bootstrap",
      agent: {
        memberId: snap.data.agentId ?? "agent",
        kind: "agent",
        agentId: snap.data.agentId ?? undefined,
      },
    });
  }, [snap.data]);

  // 2) Conversation event stream — sole message input for Web surface.
  //    No more run EventSource; all message output arrives via the conversation SSE.
  useEffect(() => {
    if (!conversationId) return;
    // Full replay on every mount: afterSeq=0 re-delivers the whole ledger,
    // so a page refresh shows the complete history. Reconnects resume via
    // Last-Event-ID (server ids), and the guard dedupes replays. No
    // sessionStorage cursor: a cursor that outlives the page would make
    // refresh look like "the agent never replied".
    const ts = typedSource(
      `/api/bff/conversations/${conversationId}/events?afterSeq=0`,
      conversationEvents,
      {
        onError: (_event, _err) => {
          /* skip malformed entries */
        },
      },
    );
    let wasDisconnected = false;
    // W4/W6: reconnected toast only shown when actual gap is detected + recovered
    let pendingGap = false;

    ts.es.onopen = () => {
      dispatch({ type: "conn", status: "open" });
      if (wasDisconnected) {
        pendingGap = true;
        wasDisconnected = false;
      }
    };

    ts.es.onerror = () => {
      const status = ts.es.readyState === EventSource.CLOSED ? "closed" : "reconnecting";
      dispatch({ type: "conn", status });
      if (status === "reconnecting") wasDisconnected = true;
    };

    // W6: bounded dedup — waterline + sliding window
    let lastAppliedSeq = 0;
    const seen = new Set<number>();
    const GUARD_WINDOW = 256;
    const guard = (entry: { seq: number }): number | null => {
      const seq = entry.seq;
      if (!Number.isFinite(seq)) return seq;
      if (seq <= lastAppliedSeq) return null;
      seen.add(seq);
      if (seen.size > GUARD_WINDOW) {
        const sorted = [...seen].sort((a: number, b: number) => a - b);
        const cutoff = sorted[sorted.length - GUARD_WINDOW]!;
        for (const s of sorted) if (s <= cutoff) seen.delete(s);
      }
      lastAppliedSeq = Math.max(lastAppliedSeq, seq);
      if (pendingGap) {
        // Hole detected on reconnect — notify user
        toast.success("Reconnected — syncing missed messages");
        pendingGap = false;
      }
      return seq;
    };

    ts.on("message", (entry) => {
      const seq = guard(entry);
      if (seq === null) return;
      if (!entry.message) return; // legacy/raw rows and heartbeat frames
      // The canonical final Message for a transient run replaces the
      // temporary bubble — match by messageId prefix `run:<runId>:`.
      const match = /^run:([^:]+):/.exec(entry.message.messageId);
      if (match?.[1] && match[1] in transientsRef.current) {
        dropTransient(match[1]);
      }
      // Re-parse through the canonical codec: the wire zod type and the
      // MessageRevision interface are structurally close but not identical
      // (nullable legacy fields, passthrough blocks); parseMessageRevision
      // is the single normalization point. Cannot fail — typedSource already
      // zod-validated the frame.
      const rev = parseMessageRevision(entry.message);
      dispatch({ type: "message", seq, message: rev, undone: entry.undone });
    });

    ts.on("undo", (entry) => {
      const seq = guard(entry);
      if (seq === null) return;
      const payload = entry.payload as { undoneSeqs?: unknown } | undefined;
      const seqs = payload?.undoneSeqs;
      if (Array.isArray(seqs) && seqs.every((n): n is number => typeof n === "number")) {
        dispatch({ type: "undo", undoneSeqs: seqs });
      }
    });

    return () => ts.close();
  }, [conversationId, dropTransient]);

  // 3) Send: optimistic dispatch + POST /conversations/:id/messages.
  //    The conversation SSE delivers the authoritative ledger revision which
  //    upserts the optimistic message by messageId. No run EventSource needed.
  const sendMut = usePostConversationMessage(conversationId);

  /** Follow one run through its Live Update stream. Transient only: the
   *  bubble is kept on `completed` until the canonical final Message
   *  replaces it (no blank frame between stream end and history commit);
   *  failed/aborted/timeout keeps it with the error pill — those runs have
   *  no canonical assistant Message to swap in, so the pill is the only
   *  failure record until reload. */
  const watchRun = useCallback(
    (runId: string, agentId: string) => {
      setActiveRuns((prev) => new Set(prev).add(runId));
      // One stream per run, tracked centrally so unmount can close all.
      const existing = runStreamsRef.current.get(runId);
      existing?.close();
      // Contract-bound stream: URL from the sseEndpoints registry, opened
      // through typedSource (the only permitted raw stream constructor).
      const { es } = typedSource(
        `/api/bff${sseEndpoints.agentRunEvents.path({ runId })}`,
        runEvents,
      );
      runStreamsRef.current.set(runId, es);
      const finish = () => {
        runStreamsRef.current.get(runId)?.close();
        runStreamsRef.current.delete(runId);
        setActiveRuns((prev) => {
          const next = new Set(prev);
          next.delete(runId);
          return next;
        });
        // Tools/todos are Run-local and never enter History: clear them at
        // terminal regardless of outcome. Only the text bubble survives on
        // completion (replaced by the canonical Message).
        clearRunToolsState(runId);
        clearRunTodosState(runId);
      };
      /** Transport failure: Live Updates are best-effort; drop the partial
       *  bubble. If the run actually completed, the canonical Message still
       *  arrives via the conversation SSE. */
      const drop = () => {
        finish();
        dropTransient(runId);
      };
      es.onerror = () => {
        // EventSource fires `error` for BOTH a genuine transport blip
        // (readyState CONNECTING, it will retry) and a server-side close
        // (readyState CLOSED, the run settled and the backend closed the
        // stream). A server close is NOT a failure: the terminal status
        // event may still be in flight (the dispatch drain is raced with
        // a 500ms cap before closeSubscribers), so dropping the bubble
        // here clears a completed answer and leaves a blank frame until
        // the canonical Message lands on the conversation SSE. Keep the
        // bubble on CLOSED; drop only on a real reconnect attempt.
        if (es.readyState === EventSource.CONNECTING) drop();
        else finish();
      };
      es.addEventListener("status", (e) => {
        try {
          const ev = JSON.parse((e as MessageEvent).data) as {
            type?: string;
            status?: string;
            error?: string;
          };
          if (ev.type !== "status") return;
          if (ev.status === "completed") {
            finish();
          } else if (["failed", "aborted", "timeout"].includes(ev.status ?? "")) {
            // Failed runs persist no canonical message: keep the bubble and
            // attach the error pill as the live failure record.
            failTransient(runId, agentId, ev.error ?? "Run failed");
            finish();
          }
        } catch {
          /* malformed - ignore */
        }
      });
      es.addEventListener("text_delta", (e) => {
        try {
          const ev = JSON.parse((e as MessageEvent).data) as { text?: string };
          if (ev.text) upsertTransient(runId, agentId, ev.text);
        } catch {
          /* malformed - ignore */
        }
      });
      es.addEventListener("thinking_delta", (e) => {
        try {
          const ev = JSON.parse((e as MessageEvent).data) as { text?: string };
          if (ev.text) upsertThinking(runId, agentId, ev.text);
        } catch {
          /* malformed - ignore */
        }
      });
      const toolStarted = (e: Event) => {
        try {
          const ev = JSON.parse((e as MessageEvent).data) as {
            toolName?: string;
            callId?: string;
          };
          if (!ev.callId) return;
          upsertToolState({
            runId,
            callId: ev.callId,
            name: ev.toolName ?? "tool",
            state: "running",
          });
        } catch {
          /* malformed - ignore */
        }
      };
      const toolCompleted = (e: Event) => {
        try {
          const ev = JSON.parse((e as MessageEvent).data) as {
            toolName?: string;
            callId?: string;
            result?: unknown;
          };
          // todo_write replaces the whole run's todo snapshot — same state
          // the backend.oma.todo_update event and the panel read.
          // todo_write arrives as native_tool_completed on the child backend
          // (their MCP mount); result shapes differ ({content}/{output} json
          // string or a direct {items}) — normalize all three.
          if (ev.toolName === "todo_write" || ev.toolName?.endsWith("__todo_write")) {
            let payload = ev.result;
            if (payload && typeof payload === "object") {
              const rec = payload as { content?: unknown; output?: unknown };
              if (typeof rec.content === "string" || typeof rec.output === "string") {
                try {
                  payload = JSON.parse((rec.content ?? rec.output) as string);
                } catch {
                  payload = undefined;
                }
              }
            }
            const items = (payload as { items?: readonly TodoItem[] } | undefined)?.items;
            if (Array.isArray(items)) setRunTodosState(runId, items);
          }
          if (!ev.callId) return;
          completeToolState(runId, ev.callId, ev.result, false);
        } catch {
          /* malformed - ignore */
        }
      };
      es.addEventListener("native_tool_started", toolStarted);
      es.addEventListener("native_tool_completed", toolCompleted);
      es.addEventListener("backend.oma.todo_update", (e) => {
        try {
          const ev = JSON.parse((e as MessageEvent).data) as {
            payload?: { items?: readonly TodoItem[] };
          };
          const items = ev.payload?.items;
          if (items) setRunTodosState(runId, items);
        } catch {
          /* malformed - ignore */
        }
      });
      es.addEventListener("backend.oma.stream_rule_triggered", (e) => {
        try {
          const ev = JSON.parse((e as MessageEvent).data) as { payload?: { rule?: string } };
          if (ev.payload?.rule) {
            pushRunNotice(
              runId,
              agentId,
              `stream rule "${ev.payload.rule}" matched — output discarded, retrying`,
            );
          }
        } catch {
          /* malformed - ignore */
        }
      });
      es.addEventListener("backend.oma.approval_request", (e) => {
        try {
          const ev = JSON.parse((e as MessageEvent).data) as {
            payload?: { callId?: string; toolName?: string; reason?: string };
          };
          const p = ev.payload;
          if (typeof p?.callId === "string") {
            setTransients((prev) => {
              const next = setTransientApproval(prev, runId, agentId, {
                callId: p.callId as string,
                toolName: typeof p.toolName === "string" ? p.toolName : "tool",
                reason: typeof p.reason === "string" ? p.reason : "",
              });
              transientsRef.current = next;
              return next;
            });
          }
        } catch {
          /* malformed - ignore */
        }
      });
      const upsertWorkflow = (
        workflowId: string,
        patch: (w: WorkflowRunState | undefined) => WorkflowRunState | undefined,
      ): void => {
        setWorkflows((prev) => {
          const next = new Map(prev);
          const updated = patch(prev.get(workflowId));
          if (updated) next.set(workflowId, updated);
          else next.delete(workflowId);
          return next;
        });
      };
      const workflowEvent =
        (kind: "started" | "agent_started" | "agent_completed" | "completed") => (e: Event) => {
          try {
            const ev = JSON.parse((e as MessageEvent).data) as {
              workflowId?: string;
              label?: string;
              agentCount?: number;
              agentId?: string;
              ok?: boolean;
              error?: string;
              totalTokens?: number;
            };
            const workflowId = String(ev.workflowId ?? "");
            if (!workflowId) return;
            if (kind === "started") {
              upsertWorkflow(workflowId, () => ({
                label: String(ev.label ?? ""),
                agentCount: Number(ev.agentCount ?? 0),
                agents: new Map(),
                ok: null,
                totalTokens: 0,
              }));
              return;
            }
            if (kind === "completed") {
              upsertWorkflow(workflowId, (w) => {
                if (!w) return w;
                return { ...w, ok: ev.ok === true, totalTokens: Number(ev.totalTokens ?? 0) };
              });
              return;
            }
            const agentId = String(ev.agentId ?? "");
            const agentState: WorkflowAgentState =
              kind === "agent_started"
                ? { label: String(ev.label ?? ""), status: "running" }
                : ev.ok === true
                  ? { label: String(ev.label ?? ""), status: "done" }
                  : {
                      label: String(ev.label ?? ""),
                      status: "failed",
                      error: String(ev.error ?? ""),
                    };
            upsertWorkflow(workflowId, (w) => {
              if (!w) return w;
              const agents = new Map(w.agents);
              agents.set(agentId, agentState);
              return { ...w, agents };
            });
          } catch {
            /* malformed - ignore */
          }
        };
      es.addEventListener("workflow_started", workflowEvent("started"));
      es.addEventListener("workflow_agent_started", workflowEvent("agent_started"));
      es.addEventListener("workflow_agent_completed", workflowEvent("agent_completed"));
      es.addEventListener("workflow_completed", workflowEvent("completed"));
    },
    [
      clearRunToolsState,
      clearRunTodosState,
      completeToolState,
      dropTransient,
      failTransient,
      pushRunNotice,
      setRunTodosState,
      upsertToolState,
      upsertTransient,
      upsertThinking,
    ],
  );

  // Poll this conversation's active runs and start live streaming for any
  // run not triggered by a local send (e.g. workflow agent nodes). This
  // makes workflow-originated agent messages stream like normal chat.
  useEffect(() => {
    if (!conversationId) return;
    let stopped = false;
    const poll = async () => {
      if (stopped) return;
      try {
        const res = await api.listAgentRuns({ conversationId });
        for (const run of res?.runs ?? []) {
          if (
            !run.runId ||
            !["running", "waiting", "commit_failed"].includes(run.status) ||
            runStreamsRef.current.has(run.runId)
          )
            continue;
          watchRun(run.runId, run.agentId);
        }
      } catch {
        /* transient poll failure — next tick retries */
      }
    };
    void poll();
    const timer = setInterval(poll, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [conversationId, watchRun]);

  const send = useCallback(
    (
      text: string,
      model?: ChatModelOverride,
      attachments?: readonly { type: "image"; mediaType: string; base64: string }[],
    ) => {
      dispatch({
        type: "send",
        text,
        viewer: { memberId: "user", kind: "human" },
      });
      // While a run is live, messages queue for after it settles (the
      // Composer queue area) instead of being injected as a live steer;
      // each queued item can be steered/edited/cancelled individually.
      const queued = isBusy(state) || activeRuns.size > 0;
      sendMut.mutate(
        {
          text,
          mode: queued ? "follow_up" : undefined,
          model,
          attachments,
        },
        {
          onSuccess: (result) => {
            for (const run of result.triggeredRuns ?? []) {
              if (!run.queued && run.runId) watchRun(run.runId, run.agentId);
            }
          },
          onSettled: () => {
            dispatch({ type: "send/settled" });
          },
          onError: () => {
            dispatch({ type: "send/error", message: "Send failed — retry" });
          },
        },
      );
    },
    [sendMut, state, watchRun, activeRuns.size],
  );

  const busy = isBusy(state) || activeRuns.size > 0;

  return {
    state,
    busy,
    send,
    activeRuns,
    transients,
    transientTools,
    runTodos,
    workflows,
    resolveApproval,
  };
}
