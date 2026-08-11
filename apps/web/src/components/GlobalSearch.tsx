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
      <mark key={i} className="bg-[var(--primary)]/30 text-[var(--ink)] rounded-sm">
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
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

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
      return;
    }
    setIsLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const data = await api.searchConversations(query.trim());
        const items = data.results ?? [];
        setResults(Array.isArray(items) ? items : []);
        setActiveIndex(items.length > 0 ? 0 : -1);
      } catch {
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
            const r = results[activeIndex]!;
            onClose();
            router.push(`/chat/${r.conversationId}?at=${r.seq}`);
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
      <div className="w-full max-w-xl rounded-lg border border-[var(--hairline)] bg-[var(--canvas)] shadow-2xl">
        {/* Header */}
        <div className="flex items-center border-b border-[var(--hairline)] px-4 py-0">
          <Search className="mr-3 h-5 w-5 shrink-0 text-[var(--mute)]" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search conversations..."
            className="flex-1 bg-transparent py-3 text-base outline-none placeholder:text-[var(--mute)]"
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            onClick={onClose}
            className="ml-2 flex h-8 w-8 shrink-0 items-center justify-center rounded text-[var(--mute)] hover:text-[var(--ink)] hover:bg-[var(--canvas-soft)]"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Results / Empty / Recent */}
        <div className="max-h-80 overflow-y-auto">
          {isLoading && (
            <div className="flex items-center justify-center py-12 text-sm text-[var(--mute)]">
              Searching...
            </div>
          )}

          {/* Empty query: show recent conversations */}
          {!isLoading && query.trim() === "" && recent.length > 0 && (
            <div className="px-2 py-2">
              <p className="px-2 pb-1 text-[10px] uppercase tracking-wider text-[var(--mute)]">
                Recent
              </p>
              {recent.map((c) => (
                <button
                  key={c.conversationId}
                  onClick={() => {
                    onClose();
                    router.push(`/chat/${c.conversationId}`);
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-[var(--canvas-soft)] text-[var(--ink)]"
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
            <div className="flex flex-col items-center py-12 text-[var(--mute)]">
              <Search className="mb-3 h-8 w-8 opacity-30" />
              <p className="text-sm">Type to search across all conversations</p>
            </div>
          )}

          {/* No results */}
          {!isLoading && query.trim() !== "" && results.length === 0 && (
            <div className="py-12 text-center text-sm text-[var(--mute)]">
              No results for &ldquo;{query}&rdquo;
            </div>
          )}

          {/* Results */}
          {!isLoading &&
            results.map((r, i) => (
              <button
                key={`${r.conversationId}-${r.seq}`}
                type="button"
                onClick={() => {
                  onClose();
                  router.push(`/chat/${r.conversationId}?at=${r.seq}`);
                }}
                onMouseEnter={() => setActiveIndex(i)}
                className={`flex w-full flex-col gap-1 border-b border-[var(--hairline)] px-4 py-3 text-left transition-colors last:border-b-0 ${i === activeIndex ? "bg-[var(--canvas-soft)]" : "hover:bg-[var(--canvas-soft)]"}`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-[var(--ink-strong)] truncate max-w-[260px]">
                    {r.conversationTitle ?? `Conversation ${r.conversationId.slice(0, 8)}`}
                  </span>
                  <span className="text-xs text-[var(--mute)] shrink-0">· {r.senderName}</span>
                  <span className="ml-auto text-xs text-[var(--mute)] shrink-0">
                    {formatTime(r.ts)}
                  </span>
                </div>
                <p className="line-clamp-2 text-sm text-[var(--ink)]">
                  {highlight(extractSnippet(r.snippet), query)}
                </p>
              </button>
            ))}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-[var(--hairline)] bg-[var(--canvas-soft)] px-4 py-2 text-[10px] text-[var(--mute)]">
          <span>{results.length > 0 ? `${results.length} results` : "Type to search"}</span>
          <div className="flex items-center gap-3">
            <span>
              <kbd className="rounded bg-[var(--canvas)] px-1.5 py-0.5 font-mono">↑↓</kbd> navigate
            </span>
            <span>
              <kbd className="rounded bg-[var(--canvas)] px-1.5 py-0.5 font-mono">↵</kbd> open
            </span>
            <span>
              <kbd className="rounded bg-[var(--canvas)] px-1.5 py-0.5 font-mono">esc</kbd> close
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
