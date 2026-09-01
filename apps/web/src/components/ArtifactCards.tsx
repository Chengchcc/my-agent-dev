"use client";

import { Package } from "lucide-react";
import { useArtifacts } from "@/features/artifacts/hooks";
import type { ArtifactMeta } from "@/lib/api";
import { ArtifactCard } from "./ArtifactCard";

export function ArtifactCards({
  conversationId,
  onPreview,
  onDownload,
}: {
  conversationId: string;
  onPreview: (artifact: ArtifactMeta) => void;
  onDownload: (artifact: ArtifactMeta) => void;
}) {
  const { data } = useArtifacts();
  const items = (data?.artifacts ?? []).filter((a) => a.source?.conversationId === conversationId);

  if (items.length === 0) return null;

  return (
    <div className="mt-4 space-y-2 border-t border-(--hairline) pt-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-kicker text-(--mute)">
        <Package size={11} />
        Artifacts {items.length}
      </div>
      {items.map((a) => (
        <ArtifactCard key={a.url} artifact={a} onPreview={onPreview} onDownload={onDownload} />
      ))}
    </div>
  );
}
