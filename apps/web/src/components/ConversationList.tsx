"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  conversationKeys,
  useConversationList,
  useDeleteConversation,
  useStartChat,
} from "@/features/conversations/hooks";

export function ConversationList({ agentId, agentName }: { agentId: string; agentName?: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data: conversations, isLoading } = useConversationList(agentId);
  const chat = useStartChat(agentId, agentName);
  const deleteConversation = useDeleteConversation();
  const [confirmId, setConfirmId] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={`sk-${i}`} className="animate-pulse h-12 bg-(--canvas-soft) rounded-lg" />
        ))}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-(--mute)">{(conversations ?? []).length} 个对话</p>
        <Button
          variant="link"
          size="sm"
          onClick={() => chat.start()}
          disabled={chat.isPending}
          className="text-xs h-auto p-0"
        >
          <Plus size={14} />
          New Conversation
        </Button>
      </div>

      {(conversations ?? []).length === 0 ? (
        <div className="text-center py-12">
          <p className="text-sm text-(--mute) mb-2">还没有对话</p>
          <Button variant="link" size="sm" onClick={() => chat.start()}>
            Create your first conversation
          </Button>
        </div>
      ) : (
        <div className="space-y-0.5">
          {(conversations ?? []).map((conv, i) => (
            <div
              key={conv.conversationId}
              role="button"
              tabIndex={0}
              onClick={() => router.push(`/chat/${conv.conversationId}`)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  router.push(`/chat/${conv.conversationId}`);
                }
              }}
              className="group w-full text-left border border-(--hairline) rounded-lg
                         hover:border-(--primary) transition-colors duration-200
                         animate-fade-in bg-(--canvas) cursor-pointer p-3 flex items-center justify-between"
              style={{ animationDelay: `${i * 0.06}s`, animationFillMode: "both" }}
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-(--ink-strong) truncate">
                  {conv.title ?? `Conversation ${conv.conversationId.slice(0, 8)}`}
                </p>
                <p className="text-[10px] text-(--mute) mt-0.5">{conv.agentId ?? "agent"}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0 ml-3 opacity-0 group-hover:opacity-100 transition-opacity">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmId(conv.conversationId);
                  }}
                  title="删除对话"
                >
                  <Trash2 size={14} />
                </Button>
                <ChevronRight size={14} className="text-(--hairline)" />
              </div>
            </div>
          ))}
        </div>
      )}
      <AlertDialog
        open={confirmId !== null}
        onOpenChange={(o) => {
          if (!o) setConfirmId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除这个对话？</AlertDialogTitle>
            <AlertDialogDescription>对话历史将一并删除，此操作不可撤销。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!confirmId) return;
                deleteConversation.mutate(confirmId, {
                  onSuccess: () => {
                    toast.success("对话已删除");
                    queryClient.invalidateQueries({ queryKey: conversationKeys.byAgent(agentId) });
                  },
                  onError: (err) => {
                    toast.error("删除对话失败", {
                      description: err instanceof Error ? err.message : "未知错误",
                    });
                  },
                });
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
