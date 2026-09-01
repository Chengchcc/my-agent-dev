"use client";

import { useState } from "react";
import { useArtifacts } from "@/features/artifacts/hooks";
import type { ArtifactMeta } from "@/lib/api";
import { ArtifactCard } from "./ArtifactCard";
import { ArtifactPreviewSheet, downloadArtifact } from "./ArtifactPreviewSheet";

export function ArtifactMarkdownCard({ url }: { url: string }) {
  const { data } = useArtifacts();
  const [preview, setPreview] = useState<ArtifactMeta | null>(null);
  const artifact = data?.artifacts.find((a) => a.url === url);

  if (!artifact) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="text-(--primary-deep) underline underline-offset-2 hover:text-(--primary)"
      >
        {url}
      </a>
    );
  }

  return (
    <>
      <ArtifactCard artifact={artifact} onPreview={setPreview} onDownload={downloadArtifact} />
      <ArtifactPreviewSheet artifact={preview} onClose={() => setPreview(null)} />
    </>
  );
}
