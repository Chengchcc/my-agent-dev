"use client";

import { Bot, Check, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useAgentList } from "@/features/agents/hooks";
import { useAddConversationMember } from "@/features/conversations/hooks";
import type { SenderRef } from "@/lib/conversation-reducer";

interface AddMemberButtonProps {
  conversationId: string;
  roster: Record<string, SenderRef>;
}

export function AddMemberButton({ conversationId, roster }: AddMemberButtonProps) {
  const [open, setOpen] = useState(false);

  const { data: agents } = useAgentList();

  const presentMemberIds = useMemo(
    () =>
      new Set(
        Object.values(roster)
          .filter((m) => m.kind === "agent")
          .map((m) => m.memberId),
      ),
    [roster],
  );

  // Sort: available agents first, already-joined agents at bottom
  const sorted = useMemo(() => {
    const list = agents ?? [];
    return [...list].sort((a, b) => {
      const aPresent = presentMemberIds.has(a.id);
      const bPresent = presentMemberIds.has(b.id);
      if (aPresent === bPresent) return 0;
      return aPresent ? 1 : -1;
    });
  }, [agents, presentMemberIds]);

  const add = useAddConversationMember(conversationId);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="ghost" size="icon-xs" title="Add agent" />}>
        <Plus size={14} />
      </DialogTrigger>

      <DialogContent className="w-80 max-h-96 flex flex-col p-0 gap-0">
        <DialogHeader className="px-4 py-3 border-b border-(--hairline)">
          <DialogTitle className="text-sm font-semibold text-(--ink-strong)">Add Agent</DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto p-2">
          {sorted.length === 0 ? (
            <p className="text-xs text-(--mute) p-2">No agents available.</p>
          ) : (
            <ul className="space-y-1">
              {sorted.map((a) => {
                const isPresent = presentMemberIds.has(a.id);
                return (
                  <li key={a.id}>
                    <Button
                      variant="ghost"
                      onClick={() =>
                        add.mutate(
                          { memberId: a.id, kind: "agent", agentId: a.id, displayName: a.name },
                          { onSuccess: () => setOpen(false) },
                        )
                      }
                      disabled={isPresent || add.isPending}
                      className="w-full flex items-center justify-start gap-2 px-2 py-1.5 h-auto rounded text-xs font-normal disabled:opacity-30 text-left"
                      title={isPresent ? "Already in this conversation" : undefined}
                    >
                      <Bot size={14} className="text-(--primary) shrink-0" />
                      <span className="text-(--body) truncate flex-1">{a.name}</span>
                      {isPresent && <Check size={12} className="text-(--mute) shrink-0" />}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
