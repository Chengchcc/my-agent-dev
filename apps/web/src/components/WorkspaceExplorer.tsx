"use client";

import { ChevronRight, FileText, Folder, FolderOpen } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { fieldClass } from "@/lib/form-styles";

/** Read-only workspace file browser (ADR 0003): directory tree + file
 *  content. Backs the agent detail "workspace" tab — the workspace files
 *  (AGENTS.md/SOUL.md/USER.md/agent.yml/knowledge/.oma) are the agent's
 *  config truth; this view reads them, never writes. */

export interface WorkspaceEntry {
  name: string;
  kind: "dir" | "file" | "symlink";
  size: number | null;
}

function dirPath(path: string, name: string): string {
  return path ? `${path}/${name}` : name;
}

function parentPath(path: string): string | null {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? null : path.slice(0, idx);
}

export function WorkspaceExplorer({ agentId }: { agentId: string }) {
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);

  const loadEntries = useCallback(
    async (p: string) => {
      setLoading(true);
      try {
        const res = (await api.listWorkspaceEntries(agentId, p)) as {
          entries?: WorkspaceEntry[];
        };
        setEntries(res.entries ?? []);
      } finally {
        setLoading(false);
      }
    },
    [agentId],
  );

  useEffect(() => {
    void loadEntries(path);
  }, [path, loadEntries]);

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

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {/* Directory listing */}
      <div className="rounded-lg border border-[var(--line)] bg-[var(--canvas-soft)] p-2 min-h-[320px]">
        <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-[var(--mute)]">
          <span className="font-mono">/{path}</span>
          {loading && <span className="animate-pulse">…</span>}
        </div>
        <ul className="text-sm">
          {parentPath(path) !== null && (
            <li>
              <button
                type="button"
                className="w-full text-left px-2 py-1 rounded hover:bg-[var(--canvas)] text-[var(--mute)]"
                onClick={() => setPath(parentPath(path)!)}
              >
                ../
              </button>
            </li>
          )}
          {entries.map((e) => (
            <li key={e.name}>
              <button
                type="button"
                className="w-full flex items-center gap-2 px-2 py-1 rounded hover:bg-[var(--canvas)] text-left"
                onClick={() =>
                  e.kind === "dir"
                    ? setPath(dirPath(path, e.name))
                    : openFile(dirPath(path, e.name))
                }
              >
                {e.kind === "dir" ? (
                  <FolderOpen className="size-4 text-blue-500" />
                ) : e.kind === "symlink" ? (
                  <Folder className="size-4 text-[var(--mute)]" />
                ) : (
                  <FileText className="size-4 text-[var(--mute)]" />
                )}
                <span className="font-mono truncate">{e.name}</span>
                {e.size !== null && (
                  <span className="ml-auto text-[10px] text-[var(--mute)]">
                    {(e.size / 1024).toFixed(1)}K
                  </span>
                )}
              </button>
            </li>
          ))}
          {!loading && entries.length === 0 && (
            <li className="px-2 py-2 text-[var(--mute)] text-xs">empty directory</li>
          )}
        </ul>
      </div>

      {/* File content */}
      <div className="rounded-lg border border-[var(--line)] bg-[var(--canvas-soft)] min-h-[320px] flex flex-col">
        <div className="flex items-center gap-1 px-3 py-2 text-xs text-[var(--mute)] border-b border-[var(--line)]">
          <ChevronRight className="size-3" />
          <span className="font-mono truncate">{selected ?? "select a file"}</span>
          {truncated && <span className="text-amber-500">— truncated (256K cap)</span>}
        </div>
        {content === null ? (
          <div className="flex-1 flex items-center justify-center text-xs text-[var(--mute)] p-4">
            Read-only: workspace files are the agent&apos;s config truth.
          </div>
        ) : (
          <pre
            className={`${fieldClass} flex-1 overflow-auto text-xs/relaxed p-3 font-mono whitespace-pre-wrap border-0 rounded-none`}
          >
            {content}
          </pre>
        )}
      </div>
    </div>
  );
}
