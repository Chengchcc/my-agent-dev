"use client";

import { File, Folder, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ReadOnlyFileViewer } from "@/components/ReadOnlyFileViewer";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

/** Read-only workspace file browser (ADR 0003), aligned with the skill-pack
 *  FileTree: a collapsible directory tree (left, fixed width) + the shared
 *  ReadOnlyFileViewer (right, fluid). The workspace files (AGENTS.md/SOUL.md/
 *  agent.yml/knowledge/.oma) are the agent's config truth; read-only. */

export interface WorkspaceEntry {
  name: string;
  kind: "dir" | "file" | "symlink";
  size: number | null;
}

function dirPath(path: string, name: string): string {
  return path ? `${path}/${name}` : name;
}

/** Recursive collapsible tree node. Each dir lazily loads on expand, like the
 *  skill-pack FileTree. */
function WorkspaceTree({
  agentId,
  path,
  depth,
  selectedPath,
  onSelectFile,
}: {
  agentId: string;
  path: string;
  depth: number;
  selectedPath: string | null;
  onSelectFile: (p: string) => void;
}) {
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = (await api.listWorkspaceEntries(agentId, path)) as {
        entries?: WorkspaceEntry[];
      };
      if (cancelled) return;
      setEntries(res.entries ?? []);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId, path]);

  if (!loaded) return null;

  if (entries.length === 0 && depth > 0) return null;

  return (
    <ul className="space-y-0.5">
      {entries.map((e) => {
        const entryPath = dirPath(path, e.name);
        if (e.kind === "dir") {
          return (
            <li key={entryPath}>
              <details className="group">
                <summary className="flex cursor-pointer items-center gap-1 py-1 pl-2 pr-1 text-sm text-(--mute) hover:text-(--ink)">
                  <Folder className="size-3.5 shrink-0 text-(--faint)" />
                  <span className="truncate">{e.name}</span>
                </summary>
                <div className="ml-2 border-l border-(--hairline)/50 pl-1">
                  <WorkspaceTree
                    agentId={agentId}
                    path={entryPath}
                    depth={depth + 1}
                    selectedPath={selectedPath}
                    onSelectFile={onSelectFile}
                  />
                </div>
              </details>
            </li>
          );
        }
        const isActive = selectedPath === entryPath;
        return (
          <li key={entryPath}>
            <button
              type="button"
              onClick={() => onSelectFile(entryPath)}
              className={`flex w-full items-center gap-1 py-1 pl-2 pr-1 text-left text-sm ${
                isActive ? "bg-(--panel2) text-(--ink)" : "text-(--mute) hover:text-(--ink)"
              }`}
            >
              <File className="size-3.5 shrink-0" />
              <span className="truncate">{e.name}</span>
              {e.size !== null && (
                <span className="ml-auto shrink-0 text-[10px] text-(--faint)">
                  {(e.size / 1024).toFixed(1)}K
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function WorkspaceExplorer({ agentId }: { agentId: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [filter, setFilter] = useState("");

  const openFile = useCallback(
    async (p: string) => {
      setSelected(p);
      setContent(null);
      setTruncated(false);
      try {
        const res = (await api.readWorkspaceFile(agentId, p)) as {
          content?: string | null;
          truncated?: boolean;
        };
        setContent(res.content ?? null);
        setTruncated(res.truncated ?? false);
      } catch {
        setContent(null);
      }
    },
    [agentId],
  );

  const filteredTree = useMemo(() => filter.trim(), [filter]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row">
      {/* Directory tree — fixed width, like the skill-pack FileTree column */}
      <div className="space-y-2 md:w-[280px] md:shrink-0">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-(--mute)" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter files…"
            className="h-7 pl-7 text-xs"
            aria-label="Filter workspace files"
          />
        </div>
        {filteredTree ? (
          <FilteredList agentId={agentId} query={filteredTree} onSelectFile={openFile} />
        ) : (
          <div className="rounded-md border border-(--hairline) p-1.5">
            <WorkspaceTree
              agentId={agentId}
              path=""
              depth={0}
              selectedPath={selected}
              onSelectFile={openFile}
            />
          </div>
        )}
      </div>

      {/* File content — fluid */}
      <div className="min-h-0 min-w-0 flex-1">
        {content === null ? (
          <div className="flex h-full min-h-[320px] flex-col rounded-lg border border-dashed border-(--hairline)">
            <div className="flex flex-1 items-center justify-center p-8 text-xs text-(--mute)">
              Select a file to view its contents.
            </div>
          </div>
        ) : (
          <ReadOnlyFileViewer path={selected ?? ""} content={content} truncated={truncated} />
        )}
      </div>
    </div>
  );
}

/** Flat filename filter across a single directory level, matching the
 *  search-affordance skills uses. */
function FilteredList({
  agentId,
  query,
  onSelectFile,
}: {
  agentId: string;
  query: string;
  onSelectFile: (p: string) => void;
}) {
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = (await api.listWorkspaceEntries(agentId, "")) as {
        entries?: WorkspaceEntry[];
      };
      if (cancelled) return;
      setEntries(res.entries ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId]);
  const q = query.toLowerCase();
  const hits = entries.filter((e) => e.name.toLowerCase().includes(q));
  if (hits.length === 0) {
    return <p className="px-2 py-2 text-xs text-(--mute)">No matching files.</p>;
  }
  return (
    <ul className="space-y-0.5 rounded-md border border-(--hairline) p-1.5">
      {hits.map((e) => {
        const p = dirPath("", e.name);
        return (
          <li key={p}>
            <button
              type="button"
              onClick={() => onSelectFile(p)}
              className="flex w-full items-center gap-1 py-1 pl-2 pr-1 text-left text-sm text-(--mute) hover:text-(--ink)"
            >
              {e.kind === "dir" ? (
                <Folder className="size-3.5 shrink-0 text-(--faint)" />
              ) : (
                <File className="size-3.5 shrink-0" />
              )}
              <span className="truncate">{e.name}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
