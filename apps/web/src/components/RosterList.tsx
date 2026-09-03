"use client";

import { Bot, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useRunningAgentRuns } from "@/features/ops/hooks";
import type { SenderRef } from "@/lib/conversation-reducer";

interface RosterListProps {
  /** The conversation's agent (1:1 collapse — exactly one). */
  agent: SenderRef | null;
  /** If provided, renders the header with a close button (for drawer/overlay). */
  onClose?: () => void;
}

/** The conversation's agent card. Agents link to their detail page. */
export function RosterList({ agent, onClose }: RosterListProps) {
  const router = useRouter();

  const { data: running } = useRunningAgentRuns();
  const busyAgents = new Set(
    (running?.runs ?? []).map((r) => r.agentId).filter((id): id is string => !!id),
  );

  const openAgent = (m: SenderRef) => {
    const id = m.agentId ?? m.memberId;
    router.push(`/team/${id}`);
  };

  if (!agent) {
    return (
      <p className="text-xs text-(--mute) px-1" aria-live="polite">
        Loading agent…
      </p>
    );
  }

  const m = agent;
  const busy = busyAgents.has(m.agentId ?? m.memberId);

  return (
    <>
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] tracking-kicker uppercase text-(--mute) font-semibold">
          Agent
        </span>
        {onClose && (
          <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close members panel">
            <X size={14} />
          </Button>
        )}
      </div>
      <ul className="space-y-1">
        <li className="list-none">
          <button
            type="button"
            onClick={() => openAgent(m)}
            className="w-full flex items-center gap-2 text-xs rounded cursor-pointer hover:bg-(--canvas-soft) transition-colors p-1 -mx-1 text-left"
            title="Open agent page"
          >
            <Bot size={14} className="text-(--primary) shrink-0" />
            <span className="truncate text-(--body) flex-1">{m.displayName ?? m.memberId}</span>
            {busy && (
              <span
                className="size-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0"
                title="Run in progress"
              />
            )}
          </button>
        </li>
      </ul>
    </>
  );
}
