"use client";

import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type ArtifactMeta, api } from "@/lib/api";
import { ArtifactPreview } from "./ArtifactPreview";

function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

export function downloadArtifact(artifact: ArtifactMeta) {
  return api.downloadArtifact(artifact.url).then((r) => {
    const blob =
      r.encoding === "base64"
        ? new Blob([Uint8Array.from(atob(r.content), (c) => c.charCodeAt(0))], {
            type: r.mimeType,
          })
        : new Blob([r.content], { type: r.mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = artifact.filename;
    a.click();
    URL.revokeObjectURL(url);
  });
}

export function ArtifactPreviewSheet({
  artifact,
  onClose,
}: {
  artifact: ArtifactMeta | null;
  onClose: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [encoding, setEncoding] = useState<"utf8" | "base64">("utf8");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!artifact) {
      setContent(null);
      setError(null);
      return;
    }
    let stopped = false;
    setContent(null);
    setError(null);
    api
      .downloadArtifact(artifact.url)
      .then((r) => {
        if (stopped) return;
        setContent(r.content);
        setEncoding(r.encoding === "base64" ? "base64" : "utf8");
      })
      .catch((e) => {
        if (stopped) return;
        setError(String(e));
      });
    return () => {
      stopped = true;
    };
  }, [artifact]);

  return (
    <Sheet open={!!artifact && !error} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-[70vw]">
        {artifact && (
          <>
            <SheetHeader>
              <SheetTitle className="truncate font-mono text-sm text-(--ink-strong)">
                {artifact.filename}
              </SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-2 truncate">
                <Badge variant="outline" className="px-1.5 py-0 h-4">
                  {artifact.mimeType}
                </Badge>
                <span className="text-[10px]">{fmtSize(artifact.size)}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto h-6 px-2"
                  onClick={() => void downloadArtifact(artifact)}
                >
                  <Download className="size-3.5" /> Download
                </Button>
              </SheetDescription>
            </SheetHeader>

            <Tabs defaultValue="preview" className="mt-4">
              <TabsList>
                <TabsTrigger value="preview">Preview</TabsTrigger>
                <TabsTrigger value="raw">Raw</TabsTrigger>
                <TabsTrigger value="info">Info</TabsTrigger>
              </TabsList>
              <TabsContent value="preview" className="mt-3">
                {content === null ? (
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-2/5" />
                    <Skeleton className="h-64 w-full" />
                  </div>
                ) : (
                  <ScrollArea className="max-h-[calc(100vh-10rem)]">
                    <ArtifactPreview
                      mimeType={artifact.mimeType}
                      content={content}
                      encoding={encoding}
                    />
                  </ScrollArea>
                )}
              </TabsContent>
              <TabsContent value="raw" className="mt-3">
                <ScrollArea className="max-h-[calc(100vh-10rem)]">
                  <pre className="whitespace-pre-wrap rounded bg-(--canvas)/60 p-2 text-[11px]">
                    {content ?? "Loading raw content…"}
                  </pre>
                </ScrollArea>
              </TabsContent>
              <TabsContent value="info" className="mt-3 space-y-1 text-xs text-(--body)">
                <div>
                  <span className="text-(--mute)">URL:</span> {artifact.url}
                </div>
                <div>
                  <span className="text-(--mute)">Folder:</span> {artifact.folder}
                </div>
                <div>
                  <span className="text-(--mute)">MIME:</span> {artifact.mimeType}
                </div>
                <div>
                  <span className="text-(--mute)">Encoding:</span> {encoding}
                </div>
                <div>
                  <span className="text-(--mute)">Size:</span> {fmtSize(artifact.size)}
                </div>
                <div>
                  <span className="text-(--mute)">Updated:</span>{" "}
                  {new Date(artifact.updatedAt).toLocaleString()}
                </div>
                {artifact.source && (
                  <div>
                    <span className="text-(--mute)">Source:</span>{" "}
                    {JSON.stringify({
                      runId: artifact.source.runId,
                      conversationId: artifact.source.conversationId,
                      agentId: artifact.source.agentId,
                    })}
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
