"use client";

import { Bot, UserCircle, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import type { SenderRef } from "@/lib/conversation-reducer";

interface RosterListProps {
  roster: Record<string, SenderRef>;
  viewerMemberId: string;
  /** If provided, renders the members header with a close button (for drawer/overlay). */
  onClose?: () => void;
}

/** Conversation members. Membership is fixed by the conversation model —
 *  agents link to their detail page instead of being added/removed here. */
export function RosterList({ roster, viewerMemberId, onClose }: RosterListProps) {
  const router = useRouter();
  const members = Object.values(roster);

  const openAgent = (m: SenderRef) => {
    const id = m.agentId ?? m.memberId;
    router.push(`/team/agents/${id}`);
  };

  return (
    <>
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] tracking-kicker uppercase text-(--mute) font-semibold">
          Members ({members.length})
        </span>
        {onClose && (
          <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close members panel">
            <X size={14} />
          </Button>
        )}
      </div>
      <ul className="space-y-1">
        {members.map((m) => {
          const isViewer = m.memberId === viewerMemberId;
          const isAgent = m.kind === "agent";
          return (
            <li
              key={m.memberId}
              {...(isAgent
                ? {
                    role: "button",
                    tabIndex: 0,
                    onClick: () => openAgent(m),
                    onKeyDown: (e: React.KeyboardEvent) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openAgent(m);
                      }
                    },
                  }
                : {})}
              className={`flex items-center gap-2 text-xs py-1 rounded ${
                isAgent
                  ? "cursor-pointer hover:bg-(--canvas-soft) transition-colors px-1 -mx-1"
                  : ""
              }`}
              title={isAgent ? "Open agent page" : undefined}
            >
              {isAgent ? (
                <Bot size={14} className="text-(--primary) shrink-0" />
              ) : (
                <UserCircle size={14} className="text-(--mute) shrink-0" />
              )}
              <span className="truncate text-(--body) flex-1">
                {m.displayName ?? m.memberId}
                {isViewer ? " (you)" : ""}
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}
