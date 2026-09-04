"use client";

import { Code2, Eye } from "lucide-react";
import { useState } from "react";
import { FileContentViewer } from "@/components/FileContentViewer";
import { Markdown } from "@/components/Markdown";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useSkillPackFiles } from "@/features/skill-packs/hooks";

/** Read-only file surface with Preview/Source toggle + file size. */
export function PackFileViewer({ packId, path }: { packId: string; path: string }) {
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const { data, isLoading } = useSkillPackFiles(packId, path);

  if (isLoading) return <Skeleton className="h-96 w-full" />;
  if (data?.type !== "file") return null;

  const content = data.content ?? "";
  const bytes = new TextEncoder().encode(content).length;
  const size = `${(bytes / 1024).toFixed(1)} KB`;
  const isPreviewable = path.endsWith(".md") || path.endsWith(".mdx");

  return (
    <div className="flex h-full min-h-[320px] flex-col overflow-hidden rounded-md border border-(--hairline) bg-(--panel)">
      <div className="flex items-center gap-2 border-b border-(--hairline) px-3 py-2 text-xs text-(--mute)">
        <span className="min-w-0 flex-1 truncate font-mono">{data.path ?? path}</span>
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
          <FileContentViewer value={content} path={data.path ?? path} />
        )}
      </div>
    </div>
  );
}
