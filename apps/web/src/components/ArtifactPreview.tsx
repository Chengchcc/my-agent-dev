"use client";

function dataUrl(mimeType: string, content: string, encoding: "utf8" | "base64"): string {
  if (encoding === "base64") return `data:${mimeType};base64,${content}`;
  return `data:${mimeType};charset=utf-8,${encodeURIComponent(content)}`;
}

const TEXT_MIME =
  /^(text\/|application\/(json|xml|csv|yaml|yml|javascript|typescript)|.*\/(markdown|md|mermaid)$)/i;

export function ArtifactPreview({
  mimeType,
  content,
  encoding,
}: {
  mimeType: string;
  content: string;
  encoding: "utf8" | "base64";
}) {
  const url = dataUrl(mimeType, content, encoding);

  if (mimeType.startsWith("image/")) {
    return (
      // biome-ignore lint/performance/noImgElement: data URL content preview
      <img
        src={url}
        alt="artifact preview"
        className="max-h-[420px] w-full object-contain rounded bg-(--canvas)/60"
      />
    );
  }

  if (mimeType === "application/pdf") {
    return (
      <iframe
        title="artifact preview"
        src={url}
        className="h-[480px] w-full rounded bg-(--canvas)/60"
      />
    );
  }

  if (mimeType.startsWith("audio/")) {
    // biome-ignore lint/a11y/useMediaCaption: user artifact preview, no captions available
    return <audio controls className="w-full" src={url} />;
  }

  if (mimeType.startsWith("video/")) {
    return (
      // biome-ignore lint/a11y/useMediaCaption: user artifact preview, no captions available
      <video controls className="max-h-[420px] w-full rounded bg-(--canvas)/60" src={url} />
    );
  }

  if (TEXT_MIME.test(mimeType) || encoding === "utf8") {
    return (
      <pre className="max-h-96 overflow-auto rounded bg-(--canvas)/60 p-2 text-[11px]">
        {content}
      </pre>
    );
  }

  return (
    <div className="text-xs text-(--mute)">
      No preview for <span className="font-mono text-(--body)">{mimeType}</span> (binary, {encoding}{" "}
      {content.length} chars).
    </div>
  );
}
