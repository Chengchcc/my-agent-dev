"use client";

import { Bot, UserCircle, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useRemoveConversationMember } from "@/features/conversations/hooks";
import type { SenderRef } from "@/lib/conversation-reducer";
import { AddMemberButton } from "./AddMemberButton";

interface RosterListProps {
  conversationId: string;
  roster: Record<string, SenderRef>;
  viewerMemberId: string;
  /** If provided, renders the members header with a close button (for drawer/overlay). */
  onClose?: () => void;
}

export function RosterList({ conversationId, roster, viewerMemberId, onClose }: RosterListProps) {
  const removeMember = useRemoveConversationMember(conversationId);

  const members = Object.values(roster);
  const memberCount = members.length;

  return (
    <>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-[10px] tracking-kicker uppercase text-(--mute) font-semibold">
            Members ({memberCount})
          </span>
        </div>
        <div className="flex items-center gap-1">
          <AddMemberButton conversationId={conversationId} roster={roster} />
          {onClose && (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onClose}
              aria-label="Close members panel"
            >
              <X size={14} />
            </Button>
          )}
        </div>
      </div>
      <ul className="space-y-1">
        {members.map((m) => {
          const isViewer = m.memberId === viewerMemberId;
          return (
            <li key={m.memberId} className="flex items-center gap-2 text-xs py-1 group">
              {m.kind === "agent" ? (
                <Bot size={14} className="text-(--primary) shrink-0" />
              ) : (
                <UserCircle size={14} className="text-(--mute) shrink-0" />
              )}
              <span className="truncate text-(--body) flex-1">
                {m.displayName ?? m.memberId}
                {isViewer ? " (you)" : ""}
              </span>
              {!isViewer && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => {
                    if (confirm(`Remove ${m.displayName ?? m.memberId} from conversation?`)) {
                      removeMember.mutate(m.memberId, {
                        onSuccess: () => toast.success("Member removed"),
                        onError: (err) =>
                          toast.error("Failed to remove member", {
                            description: err instanceof Error ? err.message : "Unknown error",
                          }),
                      });
                    }
                  }}
                  disabled={removeMember.isPending}
                  className="opacity-0 group-hover:opacity-100 transition-all disabled:opacity-0 shrink-0"
                  title={`Remove ${m.displayName ?? m.memberId}`}
                >
                  <X size={12} className="text-(--mute)" />
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
