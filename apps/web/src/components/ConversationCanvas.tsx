"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, Download } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAgentList } from "@/features/agents/hooks";
import { useArtifacts } from "@/features/artifacts/hooks";
import { artifactKeys } from "@/features/artifacts/query-keys";
import { useConversation } from "@/hooks/useConversation";
import type { ArtifactMeta, ConversationSnapshot } from "@/lib/api";
import { api } from "@/lib/api";
import type { SenderRef } from "@/lib/conversation-reducer";
import type { CommandContext } from "@/lib/slash-commands";
import { findCommand, parseArgs } from "@/lib/slash-commands";
import { extractText } from "@/lib/timeline";
import type { LiveToolCall, TodoItem } from "@/lib/transient-reducer";
import { ArtifactPreviewSheet } from "./ArtifactPreviewSheet";
import { Composer } from "./Composer";
import { StatusPill } from "./patterns";
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
  const {
    state,
    busy,
    send,
    transients,
    transientTools,
    runTodos,
    activeRuns,
    workflows,
    resolveApproval,
  } = useConversation(conversationId, snapshot);
  const { agent, items, error, streamConn } = state;
  const { data: artifactsData } = useArtifacts();
  const artifactsByRunId = useMemo(() => {
    const map = new Map<string, ArtifactMeta[]>();
    for (const a of artifactsData?.artifacts ?? []) {
      if (a.source?.runId) {
        const list = map.get(a.source.runId) ?? [];
        list.push(a);
        map.set(a.source.runId, list);
      }
    }
    return map;
  }, [artifactsData]);

  // Refresh artifacts after a run settles so the session panel picks up
  // newly uploaded outputs without a page reload.
  const qc = useQueryClient();
  const wasBusy = useRef(false);

  useEffect(() => {
    if (wasBusy.current && !busy) {
      qc.invalidateQueries({ queryKey: artifactKeys.all });
    }
    wasBusy.current = busy;
  }, [busy, qc]);

  const [previewArtifact, setPreviewArtifact] = useState<ArtifactMeta | null>(null);

  async function handleDownloadArtifact(a: ArtifactMeta) {
    try {
      const r = await api.downloadArtifact(a.url);
      const blob =
        r.encoding === "base64"
          ? new Blob([Uint8Array.from(atob(r.content), (c) => c.charCodeAt(0))], {
              type: r.mimeType,
            })
          : new Blob([r.content], { type: r.mimeType });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = a.filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(`Failed to download artifact: ${String(e)}`);
    }
  }

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
    ? "Awaiting approval"
    : currentRunStatus === "retrying"
      ? "Retrying…"
      : currentRunStatus === "compacting"
        ? "Compacting context…"
        : busy
          ? "Running"
          : null;

  const lastUserMessage = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const entry = items[i]!;
      if (entry.kind !== "message") continue;
      if (entry.sender.kind === "human") return extractText(entry.content);
    }
    return null;
  }, [items.length, items]);

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
    if (initialMessage && !initialSent.current) {
      initialSent.current = true;
      send(initialMessage);
      // Clear ?initial= from URL to prevent re-send on refresh.
      router.replace(`/chat/${conversationId}`);
    }
  }, [initialMessage, send, conversationId, router]);

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
      approval?: { callId: string; toolName: string; reason: string };
      ordered?: ReadonlyArray<{ type: "text" | "thinking"; text: string }>;
    }> = [];
    for (const [runId, t] of Object.entries(transients)) {
      const sender = agent ?? { memberId: t.agentId, kind: "agent" as const, agentId: t.agentId };
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
        ordered: t.ordered,
        ...(t.approval ? { approval: t.approval } : {}),
      });
    }
    return bubbles;
  }, [transients, transientTools, agent]);

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

  // The conversation's agent (1:1 collapse — exactly one)
  const primaryAgent = agent;

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
      };
      await cmd.execute(ctx);
    },
    [conversationId, send, currentRunId, router],
  );

  return (
    <div className="h-full flex flex-col bg-(--canvas)">
      {/* Header */}
      <div className="shrink-0 border-b border-(--hairline) px-6 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <Link
              href="/chat"
              className="text-[10px] text-(--mute) hover:text-(--body) transition-colors shrink-0"
            >
              Chat
            </Link>
            {primaryAgent && (
              <>
                <span className="text-(--hairline)">/</span>
                <span className="text-[10px] text-(--body) truncate">
                  {primaryAgent?.displayName ?? primaryAgent?.agentId ?? "Agent"}
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
            {!label && <StatusPill tone="idle">idle</StatusPill>}
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
              {primaryAgent?.displayName ?? primaryAgent?.agentId ?? "Agent"}
            </span>
            {primaryKind && (
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0 h-4 font-mono text-(--mute)"
              >
                {primaryKind}
              </Badge>
            )}
            <span className="font-mono text-[10px] text-(--faint)">{conversationId}</span>
          </div>
        )}
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
          <span className="flex-1">
            {streamConn === "closed" ? "Disconnected" : "Reconnecting…"}
          </span>
          {streamConn === "closed" && (
            <Button
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => window.location.reload()}
            >
              Reconnect
            </Button>
          )}
        </div>
      )}

      {/* Workflow progress — transient, per running workflow */}
      <WorkflowPanel workflows={workflows} />

      {/* M14.6: Todo progress — pinned above message stream */}
      <TodoPanel
        runs={Object.entries(runTodos)
          .map(([runId, items]) => ({
            runId,
            agent: agent ?? null,
            items,
          }))
          .filter(
            (r): r is { runId: string; agent: SenderRef; items: readonly TodoItem[] } =>
              r.agent !== null,
          )}
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
                  <h1 className="font-display text-2xl font-semibold tracking-tight text-(--ink-strong) mb-3">
                    {primaryAgent?.displayName ?? primaryAgent?.agentId ?? "Agent"}
                  </h1>
                )}
                <p className="text-sm text-(--mute) mb-1">
                  Send a message to start the conversation
                </p>
                <p className="text-[11px] text-(--faint)">
                  Ctrl+Enter to send · Shift+Enter for newline
                </p>
              </div>
            ) : (
              <div className="py-4">
                <Timeline
                  messages={items}
                  conversationId={conversationId}
                  scrollContainerRef={scrollRef}
                  transients={transientBubbles}
                  onResolveApproval={resolveApproval}
                  artifactsByRunId={artifactsByRunId}
                  onPreviewArtifact={setPreviewArtifact}
                  onDownloadArtifact={handleDownloadArtifact}
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
            title="Back to bottom"
          >
            <ArrowDown size={14} className="text-(--body)" />
          </Button>
        )}

        {/* Roster — desktop sidebar */}
        <aside className="hidden md:block shrink-0 w-72 border-l border-(--hairline) overflow-y-auto p-3">
          <RosterList agent={agent} />
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
          Agent
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
            <RosterList agent={agent} onClose={() => setRosterOpen(false)} />
            <UsagePanel conversationId={conversationId} />
          </aside>
        </>
      )}

      <ArtifactPreviewSheet artifact={previewArtifact} onClose={() => setPreviewArtifact(null)} />

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
