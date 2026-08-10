"use client";

import { conversationEvents } from "@my-agent-team/api-contract";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { toast } from "sonner";
import {
  useConversationSnapshot,
  usePostConversationMessage,
} from "@/features/conversations/hooks";
import type { ConversationSnapshot } from "@/lib/api";
import {
  type ConvState,
  initialState,
  isBusy,
  reducer,
  type SenderRef,
} from "@/lib/conversation-reducer";
import {
  appendTransient,
  clearRunRecaps,
  clearRunTodos,
  clearRunTools,
  completeTool,
  type LiveToolCall,
  type LiveToolMap,
  type RunTodoMap,
  removeTransient,
  setRunTodos as setRunTodosMap,
  type TodoItem,
  upsertTool,
} from "@/lib/transient-reducer";
import { typedSource } from "@/lib/typed-source";

const RECAP_STORAGE_PREFIX = "mat:recap:";

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function resolveViewerMemberId(members: SenderRef[]): string {
  const humans = members.filter((m) => m.kind === "human");
  return humans[0]?.memberId ?? "";
}

function resolveAddressedTo(s: ConvState): string[] {
  const agents = Object.values(s.roster).filter((m) => m.kind === "agent");
  if (agents.length === 0) return [];
  if (s.triggerMode === "auto") return agents.map((m) => m.memberId);
  return [];
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
  const [transients, setTransients] = useState<
    Record<string, { text: string; agentMemberId: string }>
  >({});
  const runStreamsRef = useRef(new Map<string, EventSource>());
  const transientsRef = useRef(transients);
  /** Live tool steps per run (`<runId>:<callId>` key). Run-local, transient:
   *  never written to History, cleared at run terminal. */
  const [transientTools, setTransientTools] = useState<LiveToolMap>({});
  /** Latest todo snapshot per run (todo_write replaces the whole list). */
  const [runTodos, setRunTodos] = useState<RunTodoMap>({});
  /** Latest recap text per run (one-line summary, replaced each turn). */
  const [runRecaps, setRunRecapsState] = useState<Record<string, { text: string; turn: number }>>(
    {},
  );

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
  const upsertRunRecap = useCallback(
    (runId: string, text: string, turn: number) => {
      setRunRecapsState((prev) => ({ ...prev, [runId]: { text, turn } }));
      try {
        localStorage.setItem(
          `${RECAP_STORAGE_PREFIX}${conversationId}:${runId}`,
          JSON.stringify({ text, turn, ts: Date.now() }),
        );
      } catch {
        /* localStorage full or disabled — non-critical */
      }
    },
    [conversationId],
  );
  const clearRunRecap = useCallback(
    (runId: string) => {
      setRunRecapsState((prev) => clearRunRecaps(prev, runId));
      try {
        localStorage.removeItem(`${RECAP_STORAGE_PREFIX}${conversationId}:${runId}`);
      } catch {
        /* non-critical */
      }
    },
    [conversationId],
  );

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
      setRunRecapsState({});
    };
  }, [conversationId]);

  // Restore recaps from localStorage on conversation load (best-effort:
  // recap is not persisted server-side, so localStorage is the only way
  // to survive page refresh).
  useEffect(() => {
    if (!conversationId) return;
    const prefix = `${RECAP_STORAGE_PREFIX}${conversationId}:`;
    const restored: Record<string, { text: string; turn: number }> = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith(prefix)) continue;
        const runId = key.slice(prefix.length);
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw) as { text: string; turn: number };
        restored[runId] = { text: parsed.text, turn: parsed.turn };
      }
      if (Object.keys(restored).length > 0) {
        setRunRecapsState(restored);
      }
    } catch {
      /* localStorage access failed — non-critical, start empty */
    }
  }, [conversationId]);
  const upsertTransient = useCallback((runId: string, agentMemberId: string, text: string) => {
    setTransients((prev) => {
      const next = appendTransient(prev, runId, agentMemberId, text);
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

  // 1) Snapshot bootstrap (roster + viewerMemberId)
  const snap = useConversationSnapshot(conversationId, preFetchedSnapshot);
  useEffect(() => {
    if (!snap.data) return;
    const members: SenderRef[] = snap.data.members.map((m) => ({
      memberId: m.memberId,
      kind: m.kind,
      displayName: m.displayName ?? undefined,
      agentId: m.agentId ?? undefined,
    }));
    const viewerMemberId = resolveViewerMemberId(members);
    dispatch({ type: "bootstrap", viewerMemberId, members });
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
      `/api/bff/api/conversations/${conversationId}/events?afterSeq=0`,
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
      const content = typeof entry.content === "string" ? safeParse(entry.content) : entry.content;
      if (entry.senderMemberId === "__system__") {
        dispatch({
          type: "member",
          seq,
          kind: "member.joined",
          payload: content,
        });
      } else {
        // The canonical final Message for a transient run replaces the
        // temporary bubble — match by messageId prefix `run:<runId>:`.
        if (
          content &&
          typeof content === "object" &&
          "messageId" in content &&
          typeof content.messageId === "string"
        ) {
          const match = /^run:([^:]+):/.exec(content.messageId);
          if (match?.[1] && match[1] in transientsRef.current) {
            dropTransient(match[1]);
          }
        }
        dispatch({
          type: "message",
          seq,
          senderMemberId: entry.senderMemberId,
          addressedTo: entry.addressedTo,
          content,
          undone: entry.undone,
        });
      }
    });

    ts.on("member.joined", (entry) => {
      const seq = guard(entry);
      if (seq === null) return;
      const payload = typeof entry.content === "string" ? safeParse(entry.content) : entry.content;
      dispatch({ type: "member", seq, kind: "member.joined", payload });
    });

    ts.on("member.left", (entry) => {
      const seq = guard(entry);
      if (seq === null) return;
      const payload = typeof entry.content === "string" ? safeParse(entry.content) : entry.content;
      dispatch({ type: "member", seq, kind: "member.left", payload });
    });

    ts.on("undo", (entry) => {
      const seq = guard(entry);
      if (seq === null) return;
      const payload = typeof entry.content === "string" ? safeParse(entry.content) : entry.content;
      if (payload && typeof payload === "object" && "undoneSeqs" in payload) {
        const seqs = payload.undoneSeqs;
        if (Array.isArray(seqs) && seqs.every((n): n is number => typeof n === "number")) {
          dispatch({ type: "undo", undoneSeqs: seqs });
        }
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
   *  failed/aborted/timeout drops it immediately — those runs have no
   *  canonical assistant Message to swap in. */
  const watchRun = useCallback(
    (runId: string, agentMemberId: string) => {
      setActiveRuns((prev) => new Set(prev).add(runId));
      // One stream per run, tracked centrally so unmount can close all.
      const existing = runStreamsRef.current.get(runId);
      existing?.close();
      const es = new EventSource(`/api/bff/api/agent-runs/${runId}/events`);
      runStreamsRef.current.set(runId, es);
      const done = (dropBubble: boolean) => {
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
        if (dropBubble) {
          dropTransient(runId);
          clearRunRecap(runId);
        }
      };
      // Transport failure: Live Updates are best-effort; drop the partial
      // bubble. If the run actually completed, the canonical Message still
      // arrives via the conversation SSE.
      es.onerror = () => done(true);
      es.addEventListener("status", (e) => {
        try {
          const ev = JSON.parse((e as MessageEvent).data) as {
            type?: string;
            status?: string;
          };
          if (ev.type !== "status") return;
          if (ev.status === "completed") done(false);
          else if (["failed", "aborted", "timeout"].includes(ev.status ?? "")) {
            done(true);
          }
        } catch {
          /* malformed - ignore */
        }
      });
      es.addEventListener("text_delta", (e) => {
        try {
          const ev = JSON.parse((e as MessageEvent).data) as { text?: string };
          if (ev.text) upsertTransient(runId, agentMemberId, ev.text);
        } catch {
          /* malformed - ignore */
        }
      });
      const toolStarted = (kind: "native" | "product") => (e: Event) => {
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
            kind,
            state: "running",
          });
        } catch {
          /* malformed - ignore */
        }
      };
      const toolCompleted = (_kind: "native" | "product") => (e: Event) => {
        try {
          const ev = JSON.parse((e as MessageEvent).data) as {
            callId?: string;
            result?: unknown;
          };
          if (!ev.callId) return;
          completeToolState(runId, ev.callId, ev.result, false);
        } catch {
          /* malformed - ignore */
        }
      };
      es.addEventListener("native_tool_started", toolStarted("native"));
      es.addEventListener("native_tool_completed", toolCompleted("native"));
      es.addEventListener("product_tool_started", toolStarted("product"));
      es.addEventListener("product_tool_completed", toolCompleted("product"));
      es.addEventListener("backend.coding_agent.todo_update", (e) => {
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
      es.addEventListener("backend.coding_agent.recap_update", (e) => {
        try {
          const ev = JSON.parse((e as MessageEvent).data) as {
            payload?: { text?: string; turn?: number };
          };
          if (ev.payload?.text) {
            upsertRunRecap(runId, ev.payload.text, ev.payload?.turn ?? 0);
          }
        } catch {
          /* malformed - ignore */
        }
      });
    },
    [
      clearRunRecap,
      clearRunToolsState,
      clearRunTodosState,
      completeToolState,
      dropTransient,
      setRunTodosState,
      upsertRunRecap,
      upsertToolState,
      upsertTransient,
    ],
  );

  const send = useCallback(
    (text: string, addressedTo?: string[]) => {
      const viewer = state.roster[state.viewerMemberId] ?? {
        memberId: state.viewerMemberId,
        kind: "human" as const,
      };
      const resolved = addressedTo ?? [];
      dispatch({ type: "send", text, viewer });
      // There is no client-side queue: every message is POSTed immediately
      // and the backend persists it as normal/steer/follow_up.
      sendMut.mutate(
        {
          senderMemberId: state.viewerMemberId,
          text,
          addressedTo: resolved.length > 0 ? resolved : resolveAddressedTo(state),
        },
        {
          onSuccess: (result) => {
            for (const run of result.triggeredRuns ?? []) {
              if (!run.queued && run.runId) watchRun(run.runId, run.agentMemberId);
            }
          },
          // POST pending is decremented when the HTTP request settles (both
          // success and error) - it is NOT tied to an agent reply. Run
          // activity is tracked separately via activeRuns.
          onSettled: () => {
            dispatch({ type: "send/settled" });
          },
          onError: () => {
            dispatch({ type: "send/error", message: "Send failed — retry" });
          },
        },
      );
    },
    [sendMut, state.roster, state.viewerMemberId, state, watchRun],
  );

  const toggleTriggerMode = useCallback(() => {
    dispatch({ type: "toggleTriggerMode" });
  }, []);

  const busy = isBusy(state) || activeRuns.size > 0;

  return {
    state,
    busy,
    send,
    toggleTriggerMode,
    activeRuns,
    transients,
    transientTools,
    runTodos,
    runRecaps,
  };
}
