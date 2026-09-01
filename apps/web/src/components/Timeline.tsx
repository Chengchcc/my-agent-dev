"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { SenderRef, UiItem } from "@/lib/conversation-reducer";
import { groupTurns, isTurnStart, type TurnSegment } from "@/lib/conversation-reducer";
import { renderContentBlocks } from "@/lib/render-blocks";
import { extractText } from "@/lib/timeline";
import type { LiveToolCall } from "@/lib/transient-reducer";
import { cn } from "@/lib/utils";
import { MessageBubble } from "./MessageBubble";
import { ReasoningTrace } from "./ReasoningTrace";
import { TimelineApprovalCard } from "./TimelineApprovalCard";
import { TimelineMessageActions } from "./TimelineMessageActions";
import { TimelineTransientTrace } from "./TimelineTransientTrace";

interface TimelineProps {
  messages: UiItem[];
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
        error?: string;
        notices?: string[];
        approval?: { callId: string; toolName: string; reason: string };
        /** Interleaved thinking/text deltas in arrival order. When present,
         *  the trace renders them interleaved instead of lumping all thinking
         *  on top of the text. */
        ordered?: ReadonlyArray<{ type: "text" | "thinking"; text: string }>;
      }>
    | undefined;
  onResolveApproval?: (runId: string, callId: string, decision: "allow" | "deny") => void;
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
  conversationId,
  scrollContainerRef,
  transients,
  onResolveApproval,
}: TimelineProps) {
  const segments = useMemo(() => groupTurns(messages), [messages]);
  const anchors = useMemo(() => extractAnchors(segments), [segments]);
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
    }> = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      // Anchors carry the scroll-to-turn targets (the jump nav beside the
      // timeline); the old numbered divider row was removed with the polish.
      if (isTurnStart(segments, i)) {
        const id = segmentId(seg);
        items.push({
          seg,
          anchorId: `turn-${id}`,
        });
        continue;
      }
      items.push({ seg });
    }
    return items;
  }, [segments]);
  // Index (into renderItems) of the LAST real message segment — the regen
  // affordance lives there only.
  const lastMessageIdx = useMemo(() => {
    for (let i = renderItems.length - 1; i >= 0; i--) {
      if (renderItems[i]!.seg.kind === "single") return i;
    }
    return -1;
  }, [renderItems]);

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
          {renderItems.map(({ seg, anchorId }, ri) => {
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
            const isSelf = m.sender.kind === "human";
            const isUndone = m.undone === true;
            const virt = {
              contentVisibility: "auto" as const,
              containIntrinsicSize: "auto 80px" as const,
            };
            // Skip hover actions on optimistic (seq=-1) messages - no backend target yet.
            const canAct = m.seq >= 0 && !isUndone;
            // Regen offered only on the LATEST assistant message: find the
            // nearest preceding human text to resend after undo.
            let regen: { prevUserText: string } | null = null;
            if (
              ri === lastMessageIdx &&
              m.sender.kind === "agent" &&
              m.content.state !== "streaming"
            ) {
              for (let j = messages.length - 2; j >= 0; j--) {
                const prev = messages[j]!;
                if (prev.kind === "message" && prev.sender.kind === "human") {
                  const t = extractText(prev.content).trim();
                  if (t) regen = { prevUserText: t };
                  break;
                }
              }
            }

            return (
              <div key={m.id} id={anchorId} className={anchorId ? "scroll-mt-16" : undefined}>
                <div
                  style={virt}
                  data-seq={m.seq}
                  className={`group relative ${isUndone ? "opacity-50" : ""}`}
                >
                  <TimelineMessageActions
                    conversationId={conversationId}
                    item={m}
                    canAct={canAct}
                    regen={regen}
                  >
                    {extractText(m.content) && (
                      <MessageBubble
                        align={isSelf ? "right" : "left"}
                        name={isSelf ? undefined : (m.sender.displayName ?? m.sender.memberId)}
                        kind={m.sender.kind}
                        agentId={m.sender.agentId}
                        content={extractText(m.content)}
                        isStreaming={m.content.state === "streaming"}
                        runStatus={m.content.runStatus}
                        state={m.content.state}
                        error={m.content.error?.message}
                      />
                    )}
                    {renderContentBlocks(m.content, {
                      hiddenToolNames: new Set(["todo_write"]),
                    })}
                  </TimelineMessageActions>
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
            const showBubble = text || t.error;
            return (
              <div key={`transient-${t.runId}`} className="group relative">
                {t.notices?.map((n, i) => (
                  <p
                    key={`notice-${i}`}
                    data-testid="stream-rule-notice"
                    className="px-1 py-0.5 text-xs text-amber-500"
                  >
                    ⚠ {n}
                  </p>
                ))}
                {t.approval && (
                  <TimelineApprovalCard
                    runId={t.runId}
                    approval={t.approval}
                    onResolveApproval={onResolveApproval}
                  />
                )}
                {tools.length > 0 && (
                  <TimelineTransientTrace
                    msgCount={showBubble ? 1 : 0}
                    thinking={t.thinking}
                    tools={tools}
                    ordered={t.ordered}
                  />
                )}
                {showBubble ? (
                  <MessageBubble
                    align="left"
                    name={t.sender.displayName ?? t.sender.memberId}
                    kind="agent"
                    agentId={t.sender.agentId}
                    content={t.text}
                    isStreaming={!t.error}
                    state={t.error ? "error" : undefined}
                    error={t.error}
                  />
                ) : (
                  <div
                    data-testid="thinking-placeholder"
                    className="flex items-center gap-1.5 px-1 py-2"
                    role="status"
                  >
                    <span className="sr-only">Agent is thinking</span>
                    {[0, 1, 2].map((i) => (
                      <span
                        key={i}
                        className="size-1.5 rounded-full bg-(--mute) animate-bounce"
                        style={{ animationDelay: `${i * 150}ms` }}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
