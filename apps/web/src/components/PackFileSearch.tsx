"use client";

import { Search } from "lucide-react";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

type PackSearchHit = { path: string; line: number; snippet: string };

/** Debounced full-text search over one skill pack's files.
 *  Clicking a hit opens the file in the pack drawer's viewer. */
export function PackFileSearch({
  packId,
  onOpen,
}: {
  packId: string;
  onOpen: (path: string) => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<PackSearchHit[]>([]);
  const [open, setOpen] = useState(false);

  const search = async (query: string) => {
    if (!query.trim()) {
      setHits([]);
      return;
    }
    try {
      const data = await api.searchSkillPack(packId, query.trim());
      setHits((data.results ?? []).slice(0, 20));
      setOpen(true);
    } catch {
      setHits([]);
    }
  };

  return (
    <div className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-(--mute)" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void search(q);
            }
            if (e.key === "Escape") setOpen(false);
          }}
          placeholder="Search pack files…"
          className="mb-2 h-7 pl-7 text-xs"
        />
      </div>
      {open && hits.length > 0 && (
        <div className="absolute top-full left-0 z-20 mb-1 max-h-64 w-full overflow-y-auto rounded-md border border-(--hairline) bg-(--canvas) p-1 shadow-lg">
          {hits.map((h, i) => (
            <button
              key={`${h.path}-${h.line}-${i}`}
              type="button"
              className="flex w-full flex-col items-start rounded px-2 py-1 text-left text-xs hover:bg-(--canvas-soft)"
              onClick={() => {
                onOpen(h.path);
                setOpen(false);
              }}
            >
              <span className="truncate font-mono text-[10px] text-(--mute)">
                {h.path}:{h.line}
              </span>
              <span className="line-clamp-1 text-(--body)">{h.snippet}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
