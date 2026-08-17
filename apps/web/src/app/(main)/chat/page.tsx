"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronRight, MessageSquareIcon, Search, Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { OnboardingChecklist } from "@/components/OnboardingChecklist";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useAgentList } from "@/features/agents/hooks";
import { useCreateConversation, useRecentConversations } from "@/features/conversations/hooks";
import { type AgentRow, api, getForkSourceId } from "@/lib/api";

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
    <p className="text-[10px] text-(--mute) flex items-center gap-1">
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
  const { data: agents } = useAgentList() as { data?: AgentRow[] };
  const { data: projects } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });
  const [agentId, setAgentId] = useState("default");
  const [projectId, setProjectId] = useState("");
  const selectedAgent = agents?.find((a) => a.id === agentId);

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
        ...(projectId ? { projectId } : {}),
        members: [
          {
            memberId: agentId,
            kind: "agent",
            agentId,
            displayName: selectedAgent?.name ?? "Assistant",
          },
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
        <div className="rounded-lg border border-(--hairline) bg-(--canvas) p-4 focus-within:border-(--primary) transition-colors">
          <div className="flex items-center gap-2 mb-3">
            <div className="flex items-center justify-center size-7 rounded-full bg-(--primary) text-(--canvas)">
              <Send size={13} />
            </div>
            <span className="text-sm font-semibold text-(--ink-strong)">New Chat</span>
            <select
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              onBlur={() => {
                const next = agents?.find((a) => a.id === agentId);
                if (projectId && next && !next.projects?.includes(projectId)) {
                  setProjectId("");
                }
              }}
              className="ml-auto text-xs border border-(--hairline) rounded-md bg-transparent px-2 py-1 text-(--ink-strong)"
              aria-label="Agent"
            >
              {(agents ?? []).map((a) => (
                <option key={a.id} value={a.id} disabled={a.enabled === false}>
                  {a.name}
                  {a.enabled === false ? " (disabled)" : ""}
                </option>
              ))}
            </select>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="text-xs border border-(--hairline) rounded-md bg-transparent px-2 py-1 text-(--ink-strong)"
              aria-label="Project (optional worktree)"
            >
              <option value="">No project</option>
              {(projects?.projects ?? [])
                .filter((p) => selectedAgent?.projects?.includes(p.projectId))
                .map((p) => (
                  <option key={p.projectId} value={p.projectId}>
                    {p.name}
                  </option>
                ))}
            </select>
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
            className="min-h-24 resize-none border-0 bg-transparent text-sm text-(--ink-strong) placeholder:text-(--mute) focus-visible:ring-0"
          />
          <div className="flex items-center justify-between mt-2">
            <span className="text-[10px] text-(--mute)">
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
              className="absolute left-3 top-1/2 -translate-y-1/2 text-(--mute) pointer-events-none"
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
                  className="w-full text-left border border-(--hairline) rounded-lg
                             hover:border-(--primary) transition-colors duration-200
                             bg-[var(--canvas-soft)/40] cursor-pointer p-3"
                >
                  <p className="text-xs text-(--mute) mb-1">{r.conversationId.slice(0, 8)}</p>
                  <p className="text-sm text-(--ink) line-clamp-2">{r.snippet}</p>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {/* Recent conversations */}
        <div className="flex items-center justify-between">
          <p className="text-xs text-(--mute)">
            {conversations.length} conversation{conversations.length !== 1 ? "s" : ""}
          </p>
        </div>

        {isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={`sk-${i}`} className="animate-pulse h-16 bg-(--canvas-soft) rounded-lg" />
            ))}
          </div>
        ) : conversations.length === 0 ? (
          <div className="py-12">
            <MessageSquareIcon size={28} className="text-(--mute) mx-auto mb-4" />
            <p className="mb-4 text-sm text-(--mute)">No conversations yet</p>
            <OnboardingChecklist />
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
                className="w-full text-left border border-(--hairline) rounded-lg
                           hover:border-(--primary) transition-colors duration-200
                           bg-[var(--canvas-soft)/40] active:bg-(--canvas-soft)
                           cursor-pointer p-3 flex items-center justify-between"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-(--ink) truncate">
                    {conv.title ?? `Conversation ${conv.conversationId.slice(0, 8)}`}
                  </p>
                  {conv.lastMessagePreview && (
                    <p className="text-xs text-(--mute) truncate mt-0.5">
                      {conv.lastMessagePreview}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-1">
                    <div className="flex -space-x-1.5">
                      {conv.members.slice(0, 4).map((m) => (
                        <span
                          key={m.memberId}
                          className="inline-flex items-center justify-center size-5  rounded-full
                                     border border-(--canvas) bg-(--canvas-soft)
                                     text-[9px] font-medium text-(--mute)"
                          title={m.displayName ?? m.memberId}
                        >
                          {(m.displayName ?? m.memberId).charAt(0).toUpperCase()}
                        </span>
                      ))}
                    </div>
                    <p className="text-[10px] text-(--mute)">
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
                <ChevronRight size={14} className="text-(--hairline) shrink-0 ml-3" />
              </div>
            ))}
          </div>
        )}
      </PageBody>
    </Page>
  );
}
