"use client";

import { conversationEvents } from "@my-agent-team/api-contract";
import { useCallback, useEffect, useReducer, useState } from "react";
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
import { typedSource } from "@/lib/typed-source";

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
  const [transientText, setTransientText] = useState<string | null>(null);

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
    // Resume from last known seq on page refresh (sessionStorage survives refresh).
    const storageKey = `conv-last-seq-${conversationId}`;
    const afterSeq =
      typeof window !== "undefined"
        ? parseInt(sessionStorage.getItem(storageKey) ?? "0", 10) || 0
        : 0;
    const ts = typedSource(
      `/api/bff/api/conversations/${conversationId}/events?afterSeq=${afterSeq}`,
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
      // Persist across page refresh so SSE can resume from this point
      if (typeof window !== "undefined") {
        try {
          sessionStorage.setItem(storageKey, String(lastAppliedSeq));
        } catch {
          /* quota */
        }
      }
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

    ts.on("todo", (entry) => {
      const payload = typeof entry.content === "string" ? safeParse(entry.content) : entry.content;
      const todos =
        payload && typeof payload === "object" && "todos" in payload
          ? (payload as { todos: ConvState["todos"] }).todos
          : null;
      if (Array.isArray(todos)) {
        dispatch({ type: "todo/update", todos });
      }
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
  }, [conversationId]);

  // 3) Send: optimistic dispatch + POST /conversations/:id/messages.
  //    The conversation SSE delivers the authoritative ledger revision which
  //    upserts the optimistic message by messageId. No run EventSource needed.
  const sendMut = usePostConversationMessage(conversationId);

  /** Follow one run through its Live Update stream. Transient only: when
   *  the run's terminal state is observed the run is dropped; the canonical
   *  final Message still arrives via the conversation History SSE. The
   *  stream is best-effort - losing it never affects the final Message. */
  const watchRun = useCallback((runId: string) => {
    setActiveRuns((prev) => new Set(prev).add(runId));
    const es = new EventSource(`/api/bff/api/agent-runs/${runId}/events`);
    const done = () => {
      es.close();
      setActiveRuns((prev) => {
        const next = new Set(prev);
        next.delete(runId);
        return next;
      });
      setTransientText(null);
    };
    es.onerror = done;
    es.addEventListener("status", (e) => {
      try {
        const ev = JSON.parse((e as MessageEvent).data) as {
          type?: string;
          status?: string;
        };
        if (
          ev.type === "status" &&
          ["completed", "failed", "aborted", "timeout"].includes(ev.status ?? "")
        ) {
          done();
        }
      } catch {
        /* malformed - ignore */
      }
    });
    es.addEventListener("text_delta", (e) => {
      try {
        const ev = JSON.parse((e as MessageEvent).data) as { text?: string };
        if (ev.text) setTransientText((prev) => `${prev ?? ""}${ev.text}`);
      } catch {
        /* malformed - ignore */
      }
    });
  }, []);

  const send = useCallback(
    (text: string, addressedTo?: string[]) => {
      const viewer = state.roster[state.viewerMemberId] ?? {
        memberId: state.viewerMemberId,
        kind: "human" as const,
      };
      const resolved = addressedTo ?? [];
      dispatch({ type: "send", text, viewer });
      if (isBusy(state)) {
        dispatch({ type: "queue/add", text });
      }
      sendMut.mutate(
        {
          senderMemberId: state.viewerMemberId,
          text,
          addressedTo: resolved.length > 0 ? resolved : resolveAddressedTo(state),
        },
        {
          onSuccess: (result) => {
            for (const run of result.triggeredRuns ?? []) {
              if (!run.queued && run.runId) watchRun(run.runId);
            }
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
  const queueEdit = useCallback((index: number, newText: string) => {
    dispatch({ type: "queue/edit", index, text: newText });
  }, []);
  const queueRemove = useCallback((index: number) => {
    dispatch({ type: "queue/remove", index });
  }, []);

  const busy = isBusy(state) || activeRuns.size > 0;

  return {
    state,
    busy,
    send,
    toggleTriggerMode,
    queuedMessages: state.queuedMessages,
    queueEdit,
    queueRemove,
    activeRuns,
    transientText,
  };
}
