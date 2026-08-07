"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronRight, MessageSquareIcon, Search, Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useCreateConversation, useRecentConversations } from "@/features/conversations/hooks";
import { api, getForkSourceId } from "@/lib/api";

function relativeTime(ts: number | null | undefined): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

/** Lazy "forked from X" marker - fetches source conversation title on demand. */
function ForkSourceMarker({ sourceId, createdAt }: { sourceId: string; createdAt: number }) {
  const { data: sourceConv } = useQuery({
    queryKey: ["conv", sourceId],
    queryFn: () => api.getConversation(sourceId),
    staleTime: 60_000,
  });
  const sourceTitle = sourceConv?.title ?? `Conversation ${sourceId.slice(0, 8)}`;
  return (
    <p className="text-[10px] text-[var(--mute)] flex items-center gap-1">
      <span>↳</span>
      <span className="truncate">forked from {sourceTitle}</span>
      {relativeTime(createdAt) && <span>· {relativeTime(createdAt)}</span>}
    </p>
  );
}

export default function ChatOverviewPage() {
  const router = useRouter();
  const { data, isLoading } = useRecentConversations();
  const createConv = useCreateConversation();
  const [input, setInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const { data: searchResults } = useQuery({
    queryKey: ["conversations", "search", debouncedQuery],
    queryFn: () => api.searchConversations(debouncedQuery),
    enabled: !!debouncedQuery,
  });

  function handleCreate() {
    if (!input.trim()) return;
    createConv.mutate(
      {
        members: [
          { memberId: "default", kind: "agent", agentId: "default", displayName: "Assistant" },
          {
            memberId: `human-${crypto.randomUUID().slice(0, 8)}`,
            kind: "human",
            displayName: "User",
          },
        ],
      },
      {
        onSuccess: (conv) => {
          router.push(`/chat/${conv.conversationId}?initial=${encodeURIComponent(input)}`);
        },
        onError: (err) => {
          toast.error("Failed to create conversation", {
            description: err instanceof Error ? err.message : "Unknown error",
          });
        },
      },
    );
  }

  const conversations = [...(data ?? [])].sort(
    (a, b) => (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt),
  );

  return (
    <Page>
      <PageHeader
        breadcrumb="Chat"
        title="Chat"
        description="Start a conversation or open a recent one."
      />
      <PageBody size="reading" className="space-y-6">
        {/* New chat composer: hairline border, focus ring only. */}
        <div className="rounded-lg border border-[var(--hairline)] bg-[var(--canvas)] p-4 focus-within:border-[var(--primary)] transition-colors">
          <div className="flex items-center gap-2 mb-3">
            <div className="flex items-center justify-center h-7 w-7 rounded-full bg-[var(--primary)] text-[var(--canvas)]">
              <Send size={13} />
            </div>
            <span className="text-sm font-semibold text-[var(--ink-strong)]">New Chat</span>
          </div>
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleCreate();
              }
            }}
            placeholder="What do you want to work on?"
            className="min-h-24 resize-none border-0 bg-transparent text-sm text-[var(--ink-strong)] placeholder:text-[var(--mute)] focus-visible:ring-0"
          />
          <div className="flex items-center justify-between mt-2">
            <span className="text-[10px] text-[var(--mute)]">
              Enter to send · Shift+Enter for newline
            </span>
            <Button
              size="sm"
              onClick={handleCreate}
              disabled={!input.trim() || createConv.isPending}
              className="min-w-20"
            >
              <Send size={14} />
              Start
            </Button>
          </div>
        </div>

        {/* Filter conversations (ledger search results live in Cmd+K). */}
        <div>
          <div className="relative">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--mute)] pointer-events-none"
            />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter conversations…"
              className="pl-9"
            />
          </div>
          {searchResults?.results?.length ? (
            <div className="mt-2 space-y-0.5">
              {searchResults.results.map((r) => (
                <button
                  key={`${r.conversationId}-${r.seq}`}
                  type="button"
                  onClick={() => router.push(`/chat/${r.conversationId}`)}
                  className="w-full text-left border border-[var(--hairline)] rounded-lg
                             hover:border-[var(--primary)] transition-colors duration-200
                             bg-[var(--canvas-soft)/40] cursor-pointer p-3"
                >
                  <p className="text-xs text-[var(--mute)] mb-1">{r.conversationId.slice(0, 8)}</p>
                  <p className="text-sm text-[var(--ink)] line-clamp-2">{r.snippet}</p>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {/* Recent conversations */}
        <div className="flex items-center justify-between">
          <p className="text-xs text-[var(--mute)]">
            {conversations.length} conversation{conversations.length !== 1 ? "s" : ""}
          </p>
        </div>

        {isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div
                key={`sk-${i}`}
                className="animate-pulse h-16 bg-[var(--canvas-soft)] rounded-lg"
              />
            ))}
          </div>
        ) : conversations.length === 0 ? (
          <div className="text-center py-12">
            <MessageSquareIcon size={28} className="text-[var(--mute)] mx-auto mb-2" />
            <p className="text-sm text-[var(--mute)]">No conversations yet</p>
          </div>
        ) : (
          <div className="space-y-1">
            {conversations.map((conv) => (
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
                className="w-full text-left border border-[var(--hairline)] rounded-lg
                           hover:border-[var(--primary)] transition-colors duration-200
                           bg-[var(--canvas-soft)/40] active:bg-[var(--canvas-soft)]
                           cursor-pointer p-3 flex items-center justify-between"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-[var(--ink)] truncate">
                    {conv.title ?? `Conversation ${conv.conversationId.slice(0, 8)}`}
                  </p>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-1">
                    {/* Member avatars */}
                    <div className="flex -space-x-1.5">
                      {conv.members.slice(0, 4).map((m) => (
                        <span
                          key={m.memberId}
                          className="inline-flex items-center justify-center h-5 w-5 rounded-full
                                     border border-[var(--canvas)] bg-[var(--canvas-soft)]
                                     text-[9px] font-medium text-[var(--mute)]"
                          title={m.displayName ?? m.memberId}
                        >
                          {(m.displayName ?? m.memberId).charAt(0).toUpperCase()}
                        </span>
                      ))}
                    </div>
                    <p className="text-[10px] text-[var(--mute)]">
                      {new Date(conv.createdAt).toLocaleString()}
                      {relativeTime(conv.lastActivityAt) && (
                        <span className="ml-1">· {relativeTime(conv.lastActivityAt)}</span>
                      )}
                    </p>
                    {(() => {
                      const fid = getForkSourceId(conv);
                      if (!fid) return null;
                      return <ForkSourceMarker sourceId={fid} createdAt={conv.createdAt} />;
                    })()}
                  </div>
                </div>
                <ChevronRight size={14} className="text-[var(--hairline)] shrink-0 ml-3" />
              </div>
            ))}
          </div>
        )}
      </PageBody>
    </Page>
  );
}
