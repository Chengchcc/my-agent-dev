"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Pause, Play, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useConversationGoal } from "@/features/conversations/hooks";
import { conversationKeys } from "@/features/conversations/query-keys";
import { api } from "@/lib/api";

export function ConversationGoalStatusBar({ conversationId }: { conversationId: string }) {
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
