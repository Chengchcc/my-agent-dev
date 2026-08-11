"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  useForkConversation,
  useReplayFromMessage,
  useUndoMessages,
} from "@/features/conversations/hooks";
import type { MessageItem, SenderRef, UiItem } from "@/lib/conversation-reducer";
import { groupTurns, isTurnStart, type TurnSegment } from "@/lib/conversation-reducer";
import { renderContentBlocks } from "@/lib/render-blocks";
import { extractText } from "@/lib/timeline";
import type { LiveToolCall } from "@/lib/transient-reducer";
import { cn } from "@/lib/utils";
import { LiveToolStep } from "./LiveToolStep";
import { MessageBubble } from "./MessageBubble";
import { ReasoningTrace } from "./ReasoningTrace";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";

interface TimelineProps {
  messages: UiItem[];
  viewerMemberId: string;
  conversationId: string;
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
  /** Transient streaming outputs — one temporary assistant bubble per
   *  active run at the end of the timeline, replaced by canonical Messages. */
  transients?:
    | Array<{
        runId: string;
        text: string;
        thinking: string;
        sender: SenderRef;
        tools?: readonly LiveToolCall[];
      }>
    | undefined;
}

interface TurnAnchor {
  id: string;
  seq: number;
  elementId: string;
}

function SystemNotice({ text }: { text: string }) {
  return (
    <div className="flex justify-center py-2">
      <span className="text-[11px] text-(--mute) bg-(--bg-muted) px-3 py-1 rounded-full">
        {text}
      </span>
    </div>
  );
}

// ── Transient live trace ──

/** Live trace for a streaming run: one `X messages · Y commands` summary
 *  row above the bubble, expanding into the streaming thinking (if any) and
 *  the live tool steps in appearance order. The transient data has no
 *  fine-grained text/tool interleaving, so no interleaving is fabricated —
 *  summary on top, thinking, tools in order, streaming text below. */
function TransientTrace({
  msgCount,
  thinking,
  tools,
}: {
  msgCount: number;
  thinking: string;
  tools: readonly LiveToolCall[];
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mb-0.5">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          className="flex w-full items-center gap-1.5 px-1 py-0.5 text-left
            text-[11px] font-mono text-(--mute)
            transition-colors hover:text-(--ink)"
        >
          <span className="shrink-0 text-(--primary)">{open ? "▼" : "▶"}</span>
          <span>
            {msgCount} messages · {tools.length} commands
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="my-0.5 ml-1.5 flex flex-col gap-0.5 border-l border-(--hairline) py-1 pl-2">
            {thinking.trim() && (
              <div className="px-1 py-0.5 text-[12px] italic text-(--mute)">{thinking}</div>
            )}
            {tools.map((tool) => (
              <LiveToolStep key={tool.callId} tool={tool} />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

// ── Segment helpers ──

function segmentId(seg: TurnSegment): string {
  if (seg.kind === "turn") return seg.id;
  if (seg.kind === "single") return seg.item.id;
  return seg.id; // notice
}

/** A turn starts at each user (human) message. A turn spans that user message
 *  plus every following assistant/system segment up to (but not including) the
 *  next user message. System notices never start turns; see isTurnStart. */

function extractAnchors(segments: TurnSegment[]): TurnAnchor[] {
  const anchors: TurnAnchor[] = [];
  let turnNum = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (isTurnStart(segments, i)) {
      turnNum++;
      const id = segmentId(seg);
      anchors.push({ id: `turn-${id}`, seq: turnNum, elementId: `turn-${id}` });
    }
  }
  return anchors;
}

export function Timeline({
  messages,
  viewerMemberId,
  conversationId,
  scrollContainerRef,
  transients,
}: TimelineProps) {
  const segments = useMemo(() => groupTurns(messages), [messages]);
  const anchors = useMemo(() => extractAnchors(segments), [segments]);
  // Map segment id → per-conversation turn number (1-based)
  const turnNumBySegId = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of anchors) {
      map.set(a.id.replace("turn-", ""), a.seq);
    }
    return map;
  }, [anchors]);
  const [activeAnchor, setActiveAnchor] = useState<string | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    if (anchors.length === 0) return;
    const ids = new Set(anchors.map((a) => a.elementId));
    observerRef.current?.disconnect();
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) {
          setActiveAnchor(visible[0]!.target.id);
        }
      },
      { rootMargin: "-10% 0px -80% 0px" },
    );
    for (const el of document.querySelectorAll("[id^='turn-']")) {
      if (ids.has(el.id)) obs.observe(el);
    }
    observerRef.current = obs;
    return () => obs.disconnect();
  }, [anchors]);

  const scrollToAnchor = useCallback(
    (elementId: string) => {
      const el = document.getElementById(elementId);
      if (!el) return;
      const container = scrollContainerRef?.current;
      if (container) {
        const containerRect = container.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        const HEADER_OFFSET = 72;
        const offset = Math.max(
          0,
          elRect.top - containerRect.top + container.scrollTop - HEADER_OFFSET,
        );
        container.scrollTo({ top: offset, behavior: "smooth" });
      } else {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    },
    [scrollContainerRef],
  );

  // Build a flat render list of {seg, anchorId?, turnNum?, isFirst?}
  const renderItems = useMemo(() => {
    const items: Array<{
      seg: TurnSegment;
      anchorId?: string;
      turnNum?: number;
      isFirst?: boolean;
    }> = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      // Place a turn divider/anchor before each message that starts a turn.
      if (isTurnStart(segments, i)) {
        const id = segmentId(seg);
        items.push({
          seg,
          anchorId: `turn-${id}`,
          turnNum: turnNumBySegId.get(id),
          isFirst: i === 0,
        });
        continue;
      }
      items.push({ seg });
    }
    return items;
  }, [segments, turnNumBySegId]);

  return (
    <div className="flex gap-0">
      {/* Anchor nav — right side, subtle */}
      {anchors.length > 0 && (
        <div className="relative z-10 order-2 w-8 shrink-0">
          <div className="sticky top-20 z-10 flex flex-col items-center gap-1 py-2">
            {anchors.map((a) => (
              <Button
                key={a.id}
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => scrollToAnchor(a.elementId)}
                className={cn(
                  "pointer-events-auto rounded-sm p-0 font-mono text-[10px]",
                  "text-(--mute) hover:bg-(--canvas-soft) hover:text-(--ink)",
                  a.elementId === activeAnchor &&
                    "bg-(--primary) text-(--ink-strong) hover:bg-(--primary)",
                )}
                title={`Turn ${a.seq}`}
              >
                {a.seq}
              </Button>
            ))}
          </div>
        </div>
      )}

      {/* Timeline content */}
      <div className="flex-1 min-w-0">
        <div className="max-w-3xl mx-auto">
          {renderItems.map(({ seg, anchorId, turnNum, isFirst }) => {
            if (seg.kind === "turn") {
              // Agent turn blocks never start a turn, so they carry no anchor.
              return (
                <div key={seg.id}>
                  <ReasoningTrace segment={seg} defaultOpen={false} />
                </div>
              );
            }

            if (seg.kind === "notice") {
              return (
                <div key={seg.id}>
                  <SystemNotice text={seg.text} />
                </div>
              );
            }
            // single segment: human / standalone agent (notices rendered above)
            const m = seg.item;
            const isSelf = m.sender.memberId === viewerMemberId;
            const isUndone = m.undone === true;
            const virt = {
              contentVisibility: "auto" as const,
              containIntrinsicSize: "auto 80px" as const,
            };
            // Skip hover actions on optimistic (seq=-1) messages - no backend target yet.
            const canAct = m.seq >= 0 && !isUndone;

            return (
              <div key={m.id} id={anchorId} className={anchorId ? "scroll-mt-16" : undefined}>
                {anchorId && turnNum !== undefined && !isFirst && (
                  <div className="flex items-center gap-3 py-3">
                    <div className="flex-1 h-px bg-(--hairline)" />
                    <div className="flex items-center gap-1 text-[10px] text-(--mute) shrink-0">
                      <span>#{turnNum}</span>
                    </div>
                    <div className="flex-1 h-px bg-(--hairline)" />
                  </div>
                )}
                <div
                  style={virt}
                  data-seq={m.seq}
                  className={`group relative ${isUndone ? "opacity-50" : ""}`}
                >
                  <MessageActions conversationId={conversationId} item={m} canAct={canAct}>
                    {extractText(m.content) && (
                      <MessageBubble
                        align={isSelf ? "right" : "left"}
                        name={isSelf ? undefined : (m.sender.displayName ?? m.sender.memberId)}
                        kind={m.sender.kind}
                        agentId={m.sender.agentId}
                        content={extractText(m.content)}
                        isStreaming={m.content.state === "streaming"}
                        runStatus={m.content.runStatus}
                      />
                    )}
                    {renderContentBlocks(m.content, {
                      hiddenToolNames: new Set(["todo_write"]),
                    })}
                  </MessageActions>
                  {isUndone && (
                    <div className="text-[10px] text-(--mute) italic mt-0.5">↳ undone</div>
                  )}
                </div>
              </div>
            );
          })}
          {transients?.map((t) => {
            const tools = t.tools ?? [];
            const text = t.text.trim();
            return (
              <div key={`transient-${t.runId}`} className="group relative">
                {tools.length > 0 && (
                  <TransientTrace msgCount={text ? 1 : 0} thinking={t.thinking} tools={tools} />
                )}
                {text ? (
                  <MessageBubble
                    align="left"
                    name={t.sender.displayName ?? t.sender.memberId}
                    kind="agent"
                    agentId={t.sender.agentId}
                    content={t.text}
                    isStreaming
                  />
                ) : tools.length === 0 ? (
                  <div className="px-1 py-0.5 text-[11px] italic text-(--mute)">thinking…</div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Hover action buttons + inline edit for fork/undo/replay.
 *  Buttons appear on group hover; Edit & Replay swaps the bubble for a textarea. */
function MessageActions({
  conversationId,
  item,
  canAct,
  children,
}: {
  conversationId: string;
  item: MessageItem;
  canAct: boolean;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const forkMut = useForkConversation();
  const undoMut = useUndoMessages();
  const replayMut = useReplayFromMessage();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const isUser = item.sender.kind === "human";

  const handleStartEdit = useCallback(() => {
    setDraft(extractText(item.content));
    setEditing(true);
  }, [item.content]);

  const handleConfirmReplay = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    replayMut.mutate(
      {
        id: conversationId,
        fromSeq: item.seq,
        editedContent: text,
        senderMemberId: item.sender.memberId,
        addressedTo: item.addressedTo,
      },
      {
        onSuccess: (data) => router.push(`/chat/${data.newConversationId}`),
        onError: (err) =>
          toast.error("Replay failed", {
            description: err instanceof Error ? err.message : "Unknown error",
          }),
      },
    );
    setEditing(false);
  }, [draft, replayMut, conversationId, item.seq, item.sender.memberId, item.addressedTo, router]);

  if (editing) {
    return (
      <div className="py-2 w-full max-w-[85%]">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="min-h-20 resize-none text-sm"
          autoFocus
        />
        <div className="flex gap-2 mt-1 justify-end">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setEditing(false)}
            disabled={replayMut.isPending}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleConfirmReplay}
            disabled={replayMut.isPending || !draft.trim()}
          >
            {replayMut.isPending ? "Replaying..." : "Replay"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      {children}
      {canAct && (
        <div
          className="opacity-0 group-hover:opacity-100 transition-opacity
                     flex gap-1 mt-1
                     justify-end"
        >
          {isUser ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 text-[10px] text-(--mute) hover:text-(--body)"
              onClick={handleStartEdit}
            >
              Edit &amp; Replay
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 text-[10px] text-(--mute) hover:text-(--body)"
              onClick={() =>
                undoMut.mutate(
                  { id: conversationId, count: 1 },
                  {
                    onSuccess: () => toast.success("Undone"),
                    onError: (err) =>
                      toast.error("Undo failed", {
                        description: err instanceof Error ? err.message : "Unknown error",
                      }),
                  },
                )
              }
              disabled={undoMut.isPending}
            >
              {undoMut.isPending ? "Undoing..." : "Undo"}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-6 text-[10px] text-(--mute) hover:text-(--body)"
            onClick={() =>
              forkMut.mutate(
                { id: conversationId, fromSeq: item.seq },
                {
                  onSuccess: (data) => router.push(`/chat/${data.newConversationId}`),
                  onError: (err) =>
                    toast.error("Fork failed", {
                      description: err instanceof Error ? err.message : "Unknown error",
                    }),
                },
              )
            }
            disabled={forkMut.isPending}
          >
            {forkMut.isPending ? "Forking..." : "Fork from here"}
          </Button>
        </div>
      )}
    </div>
  );
}
