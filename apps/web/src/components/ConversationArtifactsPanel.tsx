"use client";

import { Package } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useArtifacts } from "@/features/artifacts/hooks";
import { type ArtifactMeta, api } from "@/lib/api";

/** Roster panel: artifacts this conversation's agents uploaded. The agent
 *  records provenance at artifact_upload time; we filter the global list by
 *  conversationId and share the React Query cache so new artifacts appear
 *  as soon as the run settles. */
export function ConversationArtifactsPanel({ conversationId }: { conversationId: string }) {
  const { data } = useArtifacts();
  const [copied, setCopied] = useState<string | null>(null);
  const [preview, setPreview] = useState<ArtifactMeta | null>(null);
  const [previewContent, setPreviewContent] = useState<{
    content: string;
    encoding: "utf8" | "base64";
  } | null>(null);

  const items = (data?.artifacts ?? []).filter((a) => a.source?.conversationId === conversationId);

  async function openPreview(artifact: ArtifactMeta) {
    try {
      const resp = await api.downloadArtifact(artifact.url);
      setPreview(artifact);
      setPreviewContent({
        content: resp.content,
        encoding: resp.encoding === "base64" ? "base64" : "utf8",
      });
    } catch (e) {
      toast.error(`Failed to preview artifact: ${String(e)}`);
    }
  }

  return (
    <div className="mt-4 border-t border-(--hairline) pt-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-kicker text-(--mute)">
        <Package size={11} />
        Conversation artifacts {items.length}
      </div>
      {items.length === 0 ? (
        <p className="text-[10px] leading-relaxed text-(--faint)">
          Outputs produced in this conversation appear here.
        </p>
      ) : (
        <div className="space-y-0.5">
          {items.map((a) => (
            <div
              key={a.url}
              className="flex items-center gap-1 rounded px-1 py-0.5 font-mono text-[10px] text-(--info) hover:bg-(--panel2)"
            >
              <button
                className="min-w-0 flex-1 truncate text-left"
                title={`${a.url} (click to copy; reference it in a message; the agent downloads the content itself)`}
                onClick={() => {
                  void navigator.clipboard?.writeText(a.url);
                  setCopied(a.url);
                  setTimeout(() => setCopied(null), 1500);
                }}
              >
                {copied === a.url ? "Copied ✓" : a.url}
              </button>
              <Button
                size="sm"
                variant="ghost"
                className="h-5 px-1.5 text-[10px]"
                onClick={() => void openPreview(a)}
              >
                Preview
              </Button>
            </div>
          ))}
        </div>
      )}

      <Dialog open={!!preview} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="truncate font-mono text-[12px] text-(--info)">
              {preview?.url}
            </DialogTitle>
          </DialogHeader>
          {previewContent?.encoding === "utf8" ? (
            <pre className="max-h-96 overflow-auto rounded bg-(--canvas)/60 p-2 text-[11px]">
              {previewContent.content}
            </pre>
          ) : (
            <div className="text-xs text-(--mute)">
              Binary artifact, no text preview (base64 {previewContent?.content.length ?? 0} chars)
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
