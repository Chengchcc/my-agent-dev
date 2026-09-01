"use client";

import {
  Download,
  Eye,
  File,
  FileAudio,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { ArtifactMeta } from "@/lib/api";

function iconFor(mimeType: string) {
  if (mimeType.startsWith("image/")) return FileImage;
  if (mimeType.startsWith("video/")) return FileVideo;
  if (mimeType.startsWith("audio/")) return FileAudio;
  if (/sheet|excel|csv/.test(mimeType)) return FileSpreadsheet;
  if (mimeType.startsWith("text/") || /json|markdown|yaml/.test(mimeType)) return FileText;
  return File;
}

function typeLabel(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "file";
  return ext.toUpperCase();
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

export function ArtifactCard({
  artifact,
  onPreview,
  onDownload,
}: {
  artifact: ArtifactMeta;
  onPreview: (artifact: ArtifactMeta) => void;
  onDownload: (artifact: ArtifactMeta) => void;
}) {
  const Icon = iconFor(artifact.mimeType);

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-3 flex items-center gap-3">
        <Icon className="size-8 shrink-0 text-(--info)" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-xs text-(--ink-strong)">{artifact.filename}</div>
          <div className="mt-1 flex items-center gap-2 text-[10px] text-(--mute)">
            <Badge variant="outline" className="px-1.5 py-0 h-4">
              {typeLabel(artifact.filename)}
            </Badge>
            <span>{fmtSize(artifact.size)}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => onPreview(artifact)}>
            <Eye className="size-3.5" /> Preview
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onDownload(artifact)}>
            <Download className="size-3.5" /> Download
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
