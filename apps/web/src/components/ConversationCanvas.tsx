"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, Download, Pause, Play, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAgentList } from "@/features/agents/hooks";
import { useConversationGoal } from "@/features/conversations/hooks";
import { conversationKeys } from "@/features/conversations/query-keys";
import { useConversation } from "@/hooks/useConversation";
import type { ConversationSnapshot } from "@/lib/api";
import { api } from "@/lib/api";
import type { SenderRef } from "@/lib/conversation-reducer";
import type { CommandContext } from "@/lib/slash-commands";
import { findCommand, parseArgs } from "@/lib/slash-commands";
import { extractText } from "@/lib/timeline";
import type { LiveToolCall, TodoItem } from "@/lib/transient-reducer";
import { Composer } from "./Composer";
import { RecapPanel } from "./RecapPanel";
import { RosterList } from "./RosterList";
import { Timeline } from "./Timeline";
import { TodoPanel } from "./TodoPanel";
import { UsagePanel } from "./UsagePanel";
import { WorkflowPanel } from "./WorkflowPanel";

interface ConversationCanvasProps {
  conversationId: string;
  snapshot?: ConversationSnapshot | null;
  initialMessage?: string;
  anchorSeq?: number | null;
}

export function ConversationCanvas({
  conversationId,
  snapshot,
  initialMessage,
  anchorSeq,
}: ConversationCanvasProps) {
  const router = useRouter();
  const qc = useQueryClient();
  const {
    state,
    busy,
    send,
    transients,
    transientTools,
    runTodos,
    runRecaps,
    activeRuns,
    workflows,
  } = useConversation(conversationId, snapshot);
  const { viewerMemberId, roster, items, error, streamConn } = state;

  // W3+W5: use the most recent agent run's status, not first-found.
  // Scan from newest to oldest to get the current run's transient state.
  const isAwaiting = state.items.some(
    (item) =>
      item.kind === "message" && item.sender.kind === "agent" && item.content.state === "waiting",
  );
  const currentRunStatus = (() => {
    for (let i = state.items.length - 1; i >= 0; i--) {
      const item = state.items[i]!;
      if (item.kind === "message" && item.sender.kind === "agent" && item.content.runStatus) {
        return item.content.runStatus;
      }
    }
    return undefined;
  })();
  const label = isAwaiting
    ? "Awaiting Approval"
    : currentRunStatus === "retrying"
      ? "Retrying..."
      : currentRunStatus === "compacting"
        ? "Compacting..."
        : busy
          ? "Running"
          : null;

  const lastUserMessage = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const entry = items[i]!;
      if (entry.kind !== "message") continue;
      if (entry.sender.memberId === viewerMemberId) return extractText(entry.content);
    }
    return null;
  }, [viewerMemberId, items.length, items]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLen = useRef(items.length);
  const transientTextLen = useMemo(
    () => Object.values(transients).reduce((n, t) => n + t.text.length, 0),
    [transients],
  );
  const [scrolledUp, setScrolledUp] = useState(false);
  const [rosterOpen, setRosterOpen] = useState(false);
  const initialSent = useRef(false);

  // Auto-send the user's first message passed via ?initial= from chat overview.
  useEffect(() => {
    if (initialMessage && !initialSent.current && viewerMemberId) {
      initialSent.current = true;
      send(initialMessage);
      // Clear ?initial= from URL to prevent re-send on refresh.
      router.replace(`/chat/${conversationId}`);
    }
  }, [initialMessage, send, viewerMemberId, conversationId, router]);

  useEffect(() => {
    if (items.length > prevLen.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    prevLen.current = items.length;
    // Streaming bubbles grow without changing items.length — follow them.
    if (transientTextLen > 0 && !scrolledUp && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [items.length, transientTextLen, scrolledUp]);

  // One timeline bubble per active run, addressed via its agent member.
  const transientBubbles = useMemo(() => {
    const bubbles: Array<{
      runId: string;
      text: string;
      thinking: string;
      sender: SenderRef;
      tools: LiveToolCall[];
      error?: string;
      notices?: string[];
    }> = [];
    for (const [runId, t] of Object.entries(transients)) {
      const sender = Object.values(roster).find((m) => m.memberId === t.agentMemberId);
      if (!sender) continue;
      bubbles.push({
        runId,
        text: t.text,
        thinking: t.thinking,
        sender,
        tools: Object.values(transientTools).filter(
          (tool) => tool.runId === runId && tool.name !== "todo_write",
        ),
        error: t.error,
        notices: t.notices,
      });
    }
    return bubbles;
  }, [transients, transientTools, roster]);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setScrolledUp(!atBottom);
  }, []);

  // Cmd+K ?at=seq: scroll to the message and flash-highlight it.
  useEffect(() => {
    if (anchorSeq == null || !scrollRef.current) return;
    // Messages render with data-seq attributes via Timeline's MessageActions.
    // Try a few selectors to find the target element.
    const el = document.querySelector(`[data-seq="${anchorSeq}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("ring-2", "ring-[var(--primary)]/50", "rounded-lg");
      const timeout = setTimeout(() => {
        el.classList.remove("ring-2", "ring-[var(--primary)]/50", "rounded-lg");
      }, 2000);
      return () => clearTimeout(timeout);
    }
  }, [anchorSeq]);

  // Resolve the primary agent for header display (first agent in roster)
  const primaryAgent = useMemo(() => {
    const agent = Object.values(roster).find((m) => m.kind === "agent");
    return agent ?? null;
  }, [roster]);

  // Backend kind badge: agentId → agents.backendKind (D2/D3). Drives the
  // header badge; CLI backends (claude/pi/omp) run with CLI-session
  // context continuity (ADR 0002).
  const { data: agents } = useAgentList();
  const primaryKind = useMemo(() => {
    const id = primaryAgent?.agentId;
    if (!id) return undefined;
    return agents?.find((a) => a.id === id)?.backendKind;
  }, [agents, primaryAgent]);

  const handleExport = useCallback(async () => {
    const md = await api.exportConversation(conversationId);
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${conversationId}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [conversationId]);

  // Active Agent Run (from the transient Live Update stream) - /stop target.
  // Never inferred from message state; canonical History has no open runs.
  const currentRunId = activeRuns.size > 0 ? [...activeRuns][0]! : null;

  const handleSlashCommand = useCallback(
    async (input: string) => {
      const cmd = findCommand(input);
      if (!cmd) {
        // Unknown command: send as a normal message.
        send(input);
        return;
      }
      const args = parseArgs(input);
      const ctx: CommandContext = {
        conversationId,
        args,
        toast: (msg, type) =>
          type === "error"
            ? toast.error(msg)
            : type === "info"
              ? toast.info(msg)
              : toast.success(msg),
        currentRunId,
        router: { push: router.push },
        refreshGoal: () =>
          qc.invalidateQueries({ queryKey: conversationKeys.goal(conversationId) }),
      };
      await cmd.execute(ctx);
    },
    [conversationId, send, currentRunId, router, qc],
  );

  return (
    <div className="h-full flex flex-col bg-(--canvas)">
      {/* Header */}
      <div className="shrink-0 border-b border-(--hairline) px-6 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <Link
              href="/team"
              className="text-[10px] text-(--mute) hover:text-(--body) transition-colors shrink-0"
            >
              Team
            </Link>
            {primaryAgent && (
              <>
                <span className="text-(--hairline)">/</span>
                <span className="text-[10px] text-(--body) truncate">
                  {primaryAgent.displayName ?? primaryAgent.memberId}
                </span>
              </>
            )}
          </div>
          <div className="flex items-center gap-3 shrink-0 ml-4">
            {label && (
              <>
                <span
                  className={`size-1.5 rounded-full transition-colors duration-500 ${
                    busy ? "animate-dot-pulse bg-(--primary)" : "bg-(--mute)"
                  }`}
                />
                <span
                  className={`text-xs tracking-kicker uppercase font-semibold ${
                    busy ? "text-(--primary)" : "text-(--mute)"
                  }`}
                >
                  {label}
                </span>
              </>
            )}
            {!label && <span className="text-xs text-(--mute)">Idle</span>}
            <Button
              variant="ghost"
              size="icon"
              className="size-7 "
              onClick={handleExport}
              title="Export conversation"
            >
              <Download size={14} />
            </Button>
          </div>
        </div>
        {primaryAgent && (
          <div className="flex items-center gap-2 mt-2">
            <span className="text-sm font-medium text-(--ink-strong)">
              {primaryAgent.displayName ?? primaryAgent.memberId}
            </span>
            {primaryKind && (
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0 h-4 font-mono text-(--mute)"
              >
                {primaryKind}
              </Badge>
            )}
          </div>
        )}

        {/* Goal status bar */}
        <GoalStatusBar conversationId={conversationId} />
      </div>

      {/* SSE connection warning — sticky alert until the stream recovers */}
      {(streamConn === "reconnecting" || streamConn === "closed") && (
        <div
          role="alert"
          className={`sticky top-0 z-30 shrink-0 px-6 py-1.5 flex items-center gap-2 text-xs ${
            streamConn === "closed" ? "bg-(--err)/15 text-(--err)" : "bg-(--warn)/15 text-(--warn)"
          }`}
        >
          <span
            className={`size-1.5 rounded-full animate-pulse ${
              streamConn === "closed" ? "bg-(--err)" : "bg-(--warn)"
            }`}
          />
          {streamConn === "closed"
            ? "Connection lost. Reconnect by refreshing the page."
            : "Reconnecting…"}
        </div>
      )}

      {/* Workflow progress — transient, per running workflow */}
      <WorkflowPanel workflows={workflows} />

      {/* M14.6: Todo progress — pinned above message stream */}
      <TodoPanel
        runs={Object.entries(runTodos)
          .map(([runId, items]) => ({
            runId,
            agent:
              Object.values(roster).find((m) => m.memberId === transients[runId]?.agentMemberId) ??
              null,
            items,
          }))
          .filter(
            (r): r is { runId: string; agent: SenderRef; items: readonly TodoItem[] } =>
              r.agent !== null,
          )}
      />

      {/* Per-run recap summaries */}
      <RecapPanel
        runs={Object.entries(runRecaps).map(([runId, recap]) => ({
          runId,
          // Resolve agent from roster — NOT from transients (transient is
          // dropped when the canonical Message arrives, which previously
          // took the recap with it via the agent !== null filter).
          agent: Object.values(roster).find((m) => m.kind === "agent") ?? null,
          text: recap.text,
          turn: recap.turn,
        }))}
      />

      {/* Error bar */}
      {error && (
        <div className="shrink-0 border-b border-(--hairline) bg-(--canvas-soft) px-6 py-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-1 h-4 bg-(--primary)/60 shrink-0 rounded-full" />
            <p className="text-xs text-(--ink)">{error}</p>
          </div>
          {lastUserMessage && (
            <Button
              onClick={() => send(lastUserMessage)}
              className="text-xs text-(--primary) hover:text-(--primary-soft) transition-colors shrink-0 ml-4"
            >
              Retry
            </Button>
          )}
        </div>
      )}

      <div className="flex-1 flex min-h-0 relative">
        {/* Main scroll area */}
        <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[760px] p-6  pb-40">
            {items.length === 0 ? (
              <div className="flex flex-col items-start justify-center py-24">
                {primaryAgent && (
                  <h1 className="font-sans text-2xl font-normal text-(--ink-strong) mb-3">
                    {primaryAgent.displayName ?? primaryAgent.memberId}
                  </h1>
                )}
                <p className="text-sm text-(--mute) mb-6">Send a message to begin.</p>
              </div>
            ) : (
              <div className="py-4">
                <Timeline
                  messages={items}
                  viewerMemberId={viewerMemberId}
                  conversationId={conversationId}
                  scrollContainerRef={scrollRef}
                  transients={transientBubbles}
                />
              </div>
            )}
          </div>
        </div>

        {/* Scroll-to-bottom — outside scroll container so it stays fixed */}
        {scrolledUp && (
          <Button
            onClick={scrollToBottom}
            className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 bg-(--canvas) border border-(--hairline) rounded-full p-2 hover:border-(--primary) transition-colors"
            title="Scroll to bottom"
          >
            <ArrowDown size={14} className="text-(--body)" />
          </Button>
        )}

        {/* Roster — desktop sidebar */}
        <aside className="hidden md:block shrink-0 w-56 border-l border-(--hairline) overflow-y-auto p-3">
          <RosterList roster={roster} viewerMemberId={viewerMemberId} />
          <UsagePanel conversationId={conversationId} />
        </aside>

        {/* Roster — mobile trigger */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setRosterOpen(true)}
          className="md:hidden"
          aria-expanded={rosterOpen}
          aria-controls="roster-drawer"
        >
          Members ({Object.values(roster).length})
        </Button>

        {/* Roster — mobile drawer overlay */}
      </div>

      {rosterOpen && (
        <>
          <div
            className="md:hidden fixed inset-0 bg-black/40 z-40"
            onClick={() => setRosterOpen(false)}
          />
          <aside
            id="roster-drawer"
            className="md:hidden fixed right-0 inset-y-0 w-64 bg-(--canvas) border-l border-(--hairline) z-50 overflow-y-auto p-3 shadow-lg"
            role="dialog"
            aria-label="Members"
          >
            <RosterList
              roster={roster}
              viewerMemberId={viewerMemberId}
              onClose={() => setRosterOpen(false)}
            />
            <UsagePanel conversationId={conversationId} />
          </aside>
        </>
      )}

      {/* Roster — mobile drawer overlay */}

      {/* Composer */}
      <div className="shrink-0 border-t border-(--hairline)">
        <div className="flex items-center gap-2 px-6 pt-3">
          {/* Connection status */}
          {streamConn !== "open" && (
            <Badge
              variant={streamConn === "closed" ? "destructive" : "secondary"}
              className="ml-auto text-[10px] h-4 px-1.5"
            >
              {streamConn === "reconnecting"
                ? "Reconnecting"
                : streamConn === "closed"
                  ? "Disconnected"
                  : "Connecting"}
            </Badge>
          )}
        </div>
        <Composer
          conversationId={conversationId}
          onSend={send}
          onSlashCommand={handleSlashCommand}
          disabled={false}
          placeholder={busy ? "Steer the agent..." : "Send a message..."}
          roster={roster}
          isBusy={busy}
          onStop={
            currentRunId
              ? () => {
                  api.cancelAgentRun(currentRunId).then(() => toast.success("Stopped"));
                }
              : undefined
          }
        />
      </div>
    </div>
  );
}

function GoalStatusBar({ conversationId }: { conversationId: string }) {
  const qc = useQueryClient();
  const { data: goal } = useConversationGoal(conversationId);

  if (!goal?.condition) return null;

  return (
    <div className="flex items-center gap-2 mt-2 px-3 py-1.5 rounded-md bg-(--canvas-soft) border border-(--hairline)">
      <span className="text-[10px] font-semibold tracking-kicker uppercase text-(--primary) shrink-0">
        Goal
      </span>
      <span className="text-xs text-(--ink-strong) truncate flex-1">{goal.condition}</span>
      <span className="text-[10px] text-(--mute) shrink-0">
        {goal.turns} turn{goal.turns !== 1 ? "s" : ""}
      </span>
      {goal.lastReason && (
        <span
          className="text-[10px] text-(--mute) shrink-0 max-w-[200px] truncate"
          title={goal.lastReason}
        >
          · {goal.lastReason}
        </span>
      )}
      <div className="flex items-center gap-1 shrink-0">
        {goal.paused ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[10px]"
            onClick={() => {
              api.setGoal(conversationId, { action: "resume" }).then(() => {
                qc.invalidateQueries({ queryKey: conversationKeys.goal(conversationId) });
                toast.success("Goal resumed");
              });
            }}
          >
            <Play size={10} /> Resume
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[10px]"
            onClick={() => {
              api.setGoal(conversationId, { action: "pause" }).then(() => {
                qc.invalidateQueries({ queryKey: conversationKeys.goal(conversationId) });
                toast.success("Goal paused");
              });
            }}
          >
            <Pause size={10} /> Pause
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[10px] text-destructive hover:text-destructive"
          onClick={() => {
            api.setGoal(conversationId, { action: "clear" }).then(() => {
              qc.invalidateQueries({ queryKey: conversationKeys.goal(conversationId) });
              toast.success("Goal cleared");
            });
          }}
        >
          <X size={10} /> Clear
        </Button>
      </div>
    </div>
  );
}
