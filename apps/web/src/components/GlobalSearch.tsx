"use client";

import { Search, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRecentConversations } from "@/features/conversations/hooks";
import { api } from "@/lib/api";

interface SearchResult {
  conversationId: string;
  conversationTitle: string | null;
  seq: number;
  snippet: string;
  senderName: string;
  ts: number;
}

type Hit =
  | ({ type: "conversation"; href: string } & SearchResult)
  | { type: "agent"; id: string; name: string; desc?: string; href: string }
  | { type: "loop"; id: string; name: string; href: string }
  | { type: "project"; id: string; name: string; href: string };

interface GlobalSearchProps {
  open: boolean;
  onClose: () => void;
}

/** Extract readable text from search result snippet. Handles string JSON,
 *  already-parsed objects, and plain text. Never returns raw JSON. */
function extractSnippet(input: unknown): string {
  if (typeof input !== "string") return "";
  try {
    const parsed = JSON.parse(input) as {
      text?: string;
      blocks?: Array<{ type: string; text?: string }>;
    };
    if (typeof parsed.text === "string" && parsed.text.trim()) return parsed.text;
    if (Array.isArray(parsed.blocks)) {
      const text = parsed.blocks
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join(" ")
        .trim();
      if (text) return text;
    }
    // Object but no text — don't show raw JSON, return empty
    if (typeof parsed === "object" && parsed !== null) return "";
    return input.slice(0, 200);
  } catch {
    // Not JSON — return as-is if it looks like text
    return input.startsWith("{") ? "" : input.slice(0, 200);
  }
}

function formatTime(ts: number): string {
  const now = Date.now();
  const diffDays = Math.floor((now - ts) / 86_400_000);
  const d = new Date(ts);
  if (diffDays === 0) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function highlight(text: string, query: string): React.ReactNode {
  const q = query.trim();
  if (!q) return text;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "ig"));
  return parts.map((p, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="bg-(--primary)/30 text-(--ink) rounded-sm">
        {p}
      </mark>
    ) : (
      p
    ),
  );
}

export function GlobalSearch({ open, onClose }: GlobalSearchProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Hit[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [searchFailed, setSearchFailed] = useState(false);

  const { data: conversationsData } = useRecentConversations();
  const recent = (conversationsData ?? []).slice(0, 5);

  useEffect(() => {
    if (open) {
      setQuery("");
      setResults([]);
      setActiveIndex(-1);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setResults([]);
      setActiveIndex(-1);
      setSearchFailed(false);
      return;
    }
    setIsLoading(true);
    setSearchFailed(false);
    debounceRef.current = setTimeout(async () => {
      const q = query.trim().toLowerCase();
      let failed = false;
      const fail = <T,>(fallback: T): T => {
        failed = true;
        return fallback;
      };
      try {
        const [conv, agents, projects] = await Promise.all([
          api.searchConversations(query.trim()).catch(() => fail({ results: [] })),
          api.listAgents().catch(() => fail([] as Awaited<ReturnType<typeof api.listAgents>>)),
          api.listProjects().catch(() => fail({ projects: [] })),
        ]);
        setSearchFailed(failed);
        const agentList = Array.isArray(agents) ? agents : [];
        const hits: Hit[] = [
          ...(conv.results ?? []).slice(0, 5).map(
            (r): Hit => ({
              type: "conversation",
              href: `/chat/${r.conversationId}?at=${r.seq}`,
              ...r,
            }),
          ),
          ...agentList
            .filter(
              (a) => a.name.toLowerCase().includes(q) || a.backendKind.toLowerCase().includes(q),
            )
            .slice(0, 3)
            .map(
              (a): Hit => ({
                type: "agent",
                id: a.id,
                name: a.name,
                desc: a.backendKind,
                href: `/team/agents/${a.id}`,
              }),
            ),
          ...(projects.projects ?? [])
            .filter((p) => (p.name ?? "").toLowerCase().includes(q))
            .slice(0, 3)
            .map(
              (p): Hit => ({
                type: "project",
                id: p.projectId,
                name: p.name,
                href: `/team/projects/${p.projectId}`,
              }),
            ),
        ];
        setResults(hits);
        setActiveIndex(hits.length > 0 ? 0 : -1);
      } catch {
        setSearchFailed(true);
        setResults([]);
      } finally {
        setIsLoading(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          onClose();
          break;
        case "ArrowDown":
          e.preventDefault();
          setActiveIndex((prev) => (prev < results.length - 1 ? prev + 1 : 0));
          break;
        case "ArrowUp":
          e.preventDefault();
          setActiveIndex((prev) => (prev > 0 ? prev - 1 : results.length - 1));
          break;
        case "Enter":
          e.preventDefault();
          if (activeIndex >= 0 && activeIndex < results.length) {
            onClose();
            router.push(results[activeIndex]!.href);
          }
          break;
      }
    },
    [results, activeIndex, onClose, router],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[15vh]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Search conversations"
    >
      <div className="w-full max-w-xl rounded-lg border border-(--hairline) bg-(--canvas) shadow-2xl">
        {/* Header */}
        <div className="flex items-center border-b border-(--hairline) px-4 py-0">
          <Search className="mr-3 size-5 shrink-0 text-(--mute)" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 bg-transparent py-3 text-base outline-none placeholder:text-(--mute)"
            placeholder="Search chats, agents, loops, projects..."
            spellCheck={false}
          />
          <button
            type="button"
            onClick={onClose}
            className="ml-2 flex size-8 shrink-0 items-center justify-center rounded text-(--mute) hover:text-(--ink) hover:bg-(--canvas-soft)"
            aria-label="Close"
          >
            <X className="size-4 " />
          </button>
        </div>

        {/* Results / Empty / Recent */}
        <div className="max-h-80 overflow-y-auto">
          {isLoading && (
            <div className="flex items-center justify-center py-12 text-sm text-(--mute)">
              Searching...
            </div>
          )}

          {/* Empty query: show recent conversations */}
          {!isLoading && query.trim() === "" && recent.length > 0 && (
            <div className="p-2 ">
              <p className="px-2 pb-1 text-[10px] uppercase tracking-wider text-(--mute)">Recent</p>
              {recent.map((c) => (
                <button
                  key={c.conversationId}
                  onClick={() => {
                    onClose();
                    router.push(`/chat/${c.conversationId}`);
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-(--canvas-soft) text-(--ink)"
                >
                  <span className="truncate">
                    {c.title ?? `Conversation ${c.conversationId.slice(0, 8)}`}
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* Empty query, no recents */}
          {!isLoading && query.trim() === "" && recent.length === 0 && (
            <div className="flex flex-col items-center py-12 text-(--mute)">
              <Search className="mb-3 size-8 opacity-30" />
              <p className="text-sm">Type to search across all conversations</p>
            </div>
          )}

          {/* No results / backend failure — the two are not the same (T3-4) */}
          {!isLoading && query.trim() !== "" && results.length === 0 && (
            <div className="py-12 text-center text-sm text-(--mute)">
              {searchFailed ? (
                <span className="text-(--err)">Search failed — check the backend connection</span>
              ) : (
                <>No results for &ldquo;{query}&rdquo;</>
              )}
            </div>
          )}

          {/* Results */}
          {!isLoading &&
            results.map((r, i) => (
              <button
                key={`${r.type}-${"id" in r ? r.id : ""}-${i}`}
                type="button"
                onClick={() => {
                  onClose();
                  router.push(r.href);
                }}
                onMouseEnter={() => setActiveIndex(i)}
                className={`flex w-full flex-col gap-1 border-b border-(--hairline) px-4 py-3 text-left transition-colors last:border-b-0 ${i === activeIndex ? "bg-(--canvas-soft)" : "hover:bg-(--canvas-soft)"}`}
              >
                <div className="flex items-center gap-2">
                  <span className="shrink-0 rounded bg-(--canvas-soft) px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-(--mute)">
                    {r.type}
                  </span>
                  <span className="text-xs font-medium text-(--ink-strong) truncate max-w-[260px]">
                    {r.type === "conversation"
                      ? (r.conversationTitle ?? `Conversation ${r.conversationId.slice(0, 8)}`)
                      : r.name}
                  </span>
                  {r.type === "conversation" && (
                    <>
                      <span className="text-xs text-(--mute) shrink-0">· {r.senderName}</span>
                      <span className="ml-auto text-xs text-(--mute) shrink-0">
                        {formatTime(r.ts)}
                      </span>
                    </>
                  )}
                </div>
                <p className="line-clamp-2 text-sm text-(--ink)">
                  {r.type === "conversation"
                    ? highlight(extractSnippet(r.snippet), query)
                    : r.type === "agent"
                      ? highlight(r.desc ?? "", query)
                      : null}
                </p>
              </button>
            ))}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-(--hairline) bg-(--canvas-soft) px-4 py-2 text-[10px] text-(--mute)">
          <span>{results.length > 0 ? `${results.length} results` : "Type to search"}</span>
          <div className="flex items-center gap-3">
            <span>
              <kbd className="rounded bg-(--canvas) px-1.5 py-0.5 font-mono">↑↓</kbd> navigate
            </span>
            <span>
              <kbd className="rounded bg-(--canvas) px-1.5 py-0.5 font-mono">↵</kbd> open
            </span>
            <span>
              <kbd className="rounded bg-(--canvas) px-1.5 py-0.5 font-mono">esc</kbd> close
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
