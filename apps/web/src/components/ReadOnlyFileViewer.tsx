"use client";

import { Code2, Eye } from "lucide-react";
import { useState } from "react";
import { FileContentViewer } from "@/components/FileContentViewer";
import { Markdown } from "@/components/Markdown";
import { Button } from "@/components/ui/button";

/** Shared read-only file surface (Preview / Source toggle + size). Used by
 *  skill packs (`PackFileViewer`) and the agent workspace file view so both
 *  read the same display language. */
export function ReadOnlyFileViewer({
  path,
  content,
  truncated = false,
  className,
}: {
  path: string;
  content: string;
  truncated?: boolean;
  className?: string;
}) {
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const bytes = new TextEncoder().encode(content).length;
  const size = `${(bytes / 1024).toFixed(1)} KB`;
  const isPreviewable = path.endsWith(".md") || path.endsWith(".mdx");

  return (
    <div
      className={`flex h-full min-h-[320px] flex-col overflow-hidden rounded-md border border-(--hairline) bg-(--panel) ${className ?? ""}`}
    >
      <div className="flex items-center gap-2 border-b border-(--hairline) px-3 py-2 text-xs text-(--mute)">
        <span className="min-w-0 flex-1 truncate font-mono">{path}</span>
        {truncated && <span className="shrink-0 text-amber-500">— truncated (256K cap)</span>}
        <span className="shrink-0 text-(--faint)">{size}</span>
        <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-(--hairline) p-0.5">
          <Button
            variant={mode === "preview" ? "secondary" : "ghost"}
            size="xs"
            disabled={!isPreviewable}
            onClick={() => setMode("preview")}
          >
            <Eye className="size-3" />
            Preview
          </Button>
          <Button
            variant={mode === "source" ? "secondary" : "ghost"}
            size="xs"
            onClick={() => setMode("source")}
          >
            <Code2 className="size-3" />
            Source
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {mode === "preview" && isPreviewable ? (
          <div className="p-4">
            <Markdown text={content} />
          </div>
        ) : (
          <FileContentViewer value={content} path={path} truncated={truncated} />
        )}
      </div>
    </div>
  );
}
