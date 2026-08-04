"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, Download, Pause, Play, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useConversation } from "@/hooks/useConversation";
import type { ConversationSnapshot } from "@/lib/api";
import { api } from "@/lib/api";
import type { CommandContext } from "@/lib/slash-commands";
import { findCommand, parseArgs } from "@/lib/slash-commands";
import { extractText } from "@/lib/timeline";
import { Composer } from "./Composer";
import { RosterList } from "./RosterList";
import { Timeline } from "./Timeline";
import { TodoPanel } from "./TodoPanel";

interface ConversationCanvasProps {
  conversationId: string;
  snapshot?: ConversationSnapshot | null;
  initialMessage?: string;
}

export function ConversationCanvas({
  conversationId,
  snapshot,
  initialMessage,
}: ConversationCanvasProps) {
  const router = useRouter();
  const {
    state,
    busy,
    send,
    toggleTriggerMode,
    queuedMessages,
    queueEdit,
    queueRemove,
    transientText,
    activeRuns,
  } = useConversation(conversationId, snapshot);
  const { viewerMemberId, roster, items, error, todos, triggerMode, streamConn } = state;

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
  }, [items.length]);

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

  // Resolve the primary agent for header display (first agent in roster)
  const primaryAgent = useMemo(() => {
    const agent = Object.values(roster).find((m) => m.kind === "agent");
    return agent ?? null;
  }, [roster]);

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
        toggleTriggerMode,
        currentRunId,
        router: { push: router.push },
      };
      await cmd.execute(ctx);
    },
    [conversationId, send, toggleTriggerMode, currentRunId, router],
  );

  return (
    <div className="h-full flex flex-col bg-[var(--canvas)]">
      {/* Header */}
      <div className="shrink-0 border-b border-[var(--hairline)] px-6 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <Link
              href="/team"
              className="text-[10px] text-[var(--mute)] hover:text-[var(--body)] transition-colors shrink-0"
            >
              Team
            </Link>
            {primaryAgent && (
              <>
                <span className="text-[var(--hairline)]">/</span>
                <span className="text-[10px] text-[var(--body)] truncate">
                  {primaryAgent.displayName ?? primaryAgent.memberId}
                </span>
              </>
            )}
          </div>
          <div className="flex items-center gap-3 shrink-0 ml-4">
            {label && (
              <>
                <span
                  className={`w-1.5 h-1.5 rounded-full transition-colors duration-500 ${
                    busy ? "animate-dot-pulse" : ""
                  }`}
                  style={{
                    backgroundColor: busy ? "var(--primary)" : "var(--mute)",
                  }}
                />
                <span
                  className="text-xs tracking-[0.15em] uppercase font-semibold"
                  style={{
                    color: busy ? "var(--primary)" : "var(--mute)",
                  }}
                >
                  {label}
                </span>
              </>
            )}
            {!label && <span className="text-xs text-[var(--mute)]">Idle</span>}
            {busy && currentRunId && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-destructive hover:text-destructive"
                onClick={() => {
                  api.cancelAgentRun(currentRunId).then(() => toast.success("Stopped"));
                }}
              >
                Stop
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handleExport}
              title="Export conversation"
            >
              <Download size={14} />
            </Button>
          </div>
        </div>
        {primaryAgent && (
          <div className="flex items-center gap-2 mt-2">
            <span className="text-sm font-medium text-[var(--ink-strong)]">
              {primaryAgent.displayName ?? primaryAgent.memberId}
            </span>
          </div>
        )}

        {/* Goal status bar */}
        <GoalStatusBar conversationId={conversationId} />
      </div>

      {/* SSE connection warning */}
      {(streamConn === "reconnecting" || streamConn === "closed") && (
        <div
          className={`shrink-0 px-6 py-1.5 flex items-center gap-2 text-xs ${
            streamConn === "closed" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700"
          }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full animate-pulse ${
              streamConn === "closed" ? "bg-red-500" : "bg-amber-500"
            }`}
          />
          {streamConn === "closed"
            ? "Connection lost. Reconnect by refreshing the page."
            : "Reconnecting…"}
        </div>
      )}

      {/* M14.6: Todo progress — pinned above message stream */}
      <TodoPanel todos={todos} />

      {/* Error bar */}
      {error && (
        <div className="shrink-0 border-b border-[var(--hairline)] bg-[var(--canvas-soft)] px-6 py-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-1 h-4 bg-[var(--primary)]/60 shrink-0 rounded-full" />
            <p className="text-xs text-[var(--ink)]">{error}</p>
          </div>
          {lastUserMessage && (
            <Button
              onClick={() => send(lastUserMessage)}
              className="text-xs text-[var(--primary)] hover:text-[var(--primary-soft)] transition-colors shrink-0 ml-4"
            >
              Retry
            </Button>
          )}
        </div>
      )}

      <div className="flex-1 flex min-h-0 relative">
        {/* Main scroll area */}
        <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto">
          <div className="mx-auto" style={{ maxWidth: "72ch", padding: "0 1.5rem" }}>
            {items.length === 0 ? (
              <div className="flex flex-col items-start justify-center py-24">
                {primaryAgent && (
                  <h1
                    className="font-[family-name:var(--font-sans)] text-2xl font-normal text-[var(--ink-strong)] mb-3"
                    style={{ letterSpacing: "-0.65px" }}
                  >
                    {primaryAgent.displayName ?? primaryAgent.memberId}
                  </h1>
                )}
                <p className="text-sm text-[var(--mute)] mb-6">Send a message to begin.</p>
                <p className="font-[family-name:var(--font-mono)] text-[13px] text-[var(--primary)]">
                  &#x25B8; type to start
                </p>
              </div>
            ) : (
              <div className="py-4">
                <Timeline
                  messages={items}
                  viewerMemberId={viewerMemberId}
                  conversationId={conversationId}
                  scrollContainerRef={scrollRef}
                />
              </div>
            )}
          </div>
        </div>

        {/* Scroll-to-bottom — outside scroll container so it stays fixed */}
        {scrolledUp && (
          <Button
            onClick={scrollToBottom}
            className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 bg-[var(--canvas)] border border-[var(--hairline)] rounded-full p-2 hover:border-[var(--primary)] transition-colors"
            title="Scroll to bottom"
          >
            <ArrowDown size={14} className="text-[var(--body)]" />
          </Button>
        )}

        {/* Roster — desktop sidebar */}
        <aside className="hidden md:block shrink-0 w-56 border-l border-[var(--hairline)] overflow-y-auto p-3">
          <RosterList
            conversationId={conversationId}
            roster={roster}
            viewerMemberId={viewerMemberId}
          />
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
        {rosterOpen && (
          <>
            <div
              className="md:hidden fixed inset-0 bg-black/40 z-40"
              onClick={() => setRosterOpen(false)}
            />
            <aside
              id="roster-drawer"
              className="md:hidden fixed right-0 top-0 bottom-0 w-64 bg-[var(--canvas)] border-l border-[var(--hairline)] z-50 overflow-y-auto p-3 shadow-lg"
              role="dialog"
              aria-label="Members"
            >
              <RosterList
                conversationId={conversationId}
                roster={roster}
                viewerMemberId={viewerMemberId}
                onClose={() => setRosterOpen(false)}
              />
            </aside>
          </>
        )}

        {/* Transient Agent Run output (Live Updates) - never canonical */}
        {transientText && (
          <div className="shrink-0 border-t border-[var(--hairline)] px-4 py-2 text-sm text-[var(--mute)] italic">
            {transientText}
            <span className="ml-1 animate-pulse">▍</span>
          </div>
        )}
      </div>

      {/* Queued steer messages */}
      {queuedMessages.length > 0 && (
        <div className="shrink-0 border-t border-[var(--hairline)] bg-[var(--canvas-soft)]/50 px-6 py-3">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[10px] text-[var(--mute)] uppercase tracking-wide">
              Queued ({queuedMessages.length})
            </span>
          </div>
          <div className="space-y-2">
            {queuedMessages.map((msg, i) => (
              <QueuedMessageBubble
                key={i}
                text={msg}
                onEdit={(newText) => {
                  queueEdit(i, newText);
                  send(newText);
                }}
                onRemove={() => queueRemove(i)}
              />
            ))}
          </div>
        </div>
      )}
      {/* Composer */}
      <div className="shrink-0 border-t border-[var(--hairline)]">
        <div className="flex items-center gap-2 px-6 pt-3">
          <Button
            onClick={toggleTriggerMode}
            className="text-[10px] tracking-[0.1em] uppercase px-2 py-0.5 rounded border border-[var(--hairline)] text-[var(--mute)] hover:text-[var(--body)] hover:border-[var(--primary)] transition-colors"
            title={
              triggerMode === "auto"
                ? "Auto: messages sent to all agents"
                : "Mention: use @ to address specific agents"
            }
          >
            {triggerMode === "auto" ? "Auto" : "@ Mention"}
          </Button>
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
          onSend={send}
          onSlashCommand={handleSlashCommand}
          disabled={false}
          placeholder={busy ? "Steer the agent..." : "Send a message..."}
          roster={roster}
          autoAgentCount={Object.values(roster).filter((m) => m.kind === "agent").length}
        />
      </div>
    </div>
  );
}
function QueuedMessageBubble({
  text,
  onEdit,
  onRemove,
}: {
  text: string;
  onEdit: (newText: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);

  if (editing) {
    return (
      <div className="flex items-center gap-2 rounded-md bg-background px-3 py-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="flex-1 text-sm bg-transparent outline-none resize-none"
          rows={2}
        />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            onEdit(draft);
            setEditing(false);
          }}
        >
          Save
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setDraft(text);
            setEditing(false);
          }}
        >
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-md bg-background/50 px-3 py-2">
      <span className="flex-1 text-sm text-[var(--body)] opacity-70">{text}</span>
      <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => setEditing(true)}>
        ✏️
      </Button>
      <Button size="sm" variant="ghost" className="h-6 px-2" onClick={onRemove}>
        ✕
      </Button>
    </div>
  );
}

function GoalStatusBar({ conversationId }: { conversationId: string }) {
  const qc = useQueryClient();
  const { data: goal } = useQuery({
    queryKey: ["goal", conversationId],
    queryFn: () => api.getGoal(conversationId),
    refetchInterval: 5000,
  });

  if (!goal?.condition) return null;

  return (
    <div className="flex items-center gap-2 mt-2 px-3 py-1.5 rounded-md bg-[var(--canvas-soft)] border border-[var(--hairline)]">
      <span className="text-[10px] font-semibold tracking-[2px] uppercase text-[var(--primary)] shrink-0">
        Goal
      </span>
      <span className="text-xs text-[var(--ink-strong)] truncate flex-1">{goal.condition}</span>
      <span className="text-[10px] text-[var(--mute)] shrink-0">
        {goal.turns} turn{goal.turns !== 1 ? "s" : ""}
      </span>
      {goal.lastReason && (
        <span
          className="text-[10px] text-[var(--mute)] shrink-0 max-w-[200px] truncate"
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
                qc.invalidateQueries({ queryKey: ["goal", conversationId] });
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
                qc.invalidateQueries({ queryKey: ["goal", conversationId] });
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
              qc.invalidateQueries({ queryKey: ["goal", conversationId] });
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
