"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  useForkConversation,
  usePostConversationMessage,
  useReplayFromMessage,
  useUndoMessages,
} from "@/features/conversations/hooks";
import type { MessageItem } from "@/lib/conversation-reducer";
import { extractText } from "@/lib/timeline";

/** Assistant messages carry their run id in the message id (`run:<id>:…`).
 *  Canonical Message exposes it as `id`; raw revisions as `messageId`. */
function runIdOf(item: MessageItem): string | null {
  const c = item.content;
  const mid =
    c.id ?? ("messageId" in c && typeof c.messageId === "string" ? c.messageId : undefined);
  const m = /^run:([^:]+):/.exec(mid ?? "");
  return m ? m[1]! : null;
}

interface TimelineMessageActionsProps {
  conversationId: string;
  item: MessageItem;
  canAct: boolean;
  /** Regen context for the latest assistant message: the preceding user
   *  text to resend after undoing the assistant turn. */
  regen?: { prevUserText: string } | null;
  children: React.ReactNode;
}

/** Hover action buttons + inline edit for fork/undo/replay.
 *  Buttons appear on group hover; Edit & Replay swaps the bubble for a textarea. */
export function TimelineMessageActions({
  conversationId,
  item,
  canAct,
  regen,
  children,
}: TimelineMessageActionsProps) {
  const router = useRouter();
  const forkMut = useForkConversation();
  const undoMut = useUndoMessages();
  const replayMut = useReplayFromMessage();
  const postMut = usePostConversationMessage(conversationId);

  const handleRegenerate = useCallback(() => {
    if (!regen?.prevUserText) return;
    undoMut.mutate(
      { id: conversationId, count: 1 },
      {
        onSuccess: () => postMut.mutate({ text: regen.prevUserText }),
        onError: (err) =>
          toast.error("Regenerate failed", {
            description: err instanceof Error ? err.message : "Unknown error",
          }),
      },
    );
  }, [regen, undoMut, postMut, conversationId]);
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
  }, [draft, replayMut, conversationId, item.seq, router]);

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
          <Button
            size="sm"
            variant="ghost"
            className="h-6 text-[10px] text-(--mute) hover:text-(--body)"
            onClick={() => {
              const text = extractText(item.content);
              void navigator.clipboard?.writeText(text).then(
                () => toast.success("Copied"),
                () => toast.error("Copy failed"),
              );
            }}
          >
            Copy
          </Button>
          {isUser ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 text-[10px] text-(--mute) hover:text-(--body)"
              onClick={handleStartEdit}
            >
              Edit & resend
            </Button>
          ) : (
            <>
              {runIdOf(item) && (
                <Link
                  href={`/system/runs/${runIdOf(item)}?from=${encodeURIComponent(`/chat/${conversationId}`)}`}
                  className="inline-flex h-6 items-center px-2 text-[10px] text-(--mute) hover:text-(--body)"
                  title="Open run detail"
                >
                  Run detail ↗
                </Link>
              )}
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
                {undoMut.isPending ? "Undoing…" : "Undo"}
              </Button>
            </>
          )}
          {!isUser && regen && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 text-[10px] text-(--mute) hover:text-(--body)"
              onClick={handleRegenerate}
              disabled={undoMut.isPending || postMut.isPending}
            >
              Regenerate
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
            {forkMut.isPending ? "Forking…" : "Fork from here"}
          </Button>
        </div>
      )}
    </div>
  );
}
