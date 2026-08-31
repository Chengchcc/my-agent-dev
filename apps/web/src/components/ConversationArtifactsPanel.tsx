"use client";

import { Package } from "lucide-react";
import { useEffect, useState } from "react";
import { type ArtifactMeta, api } from "@/lib/api";

/** Roster panel: artifacts this conversation's agents uploaded. The agent
 *  records provenance at artifact_upload time; we filter the global list by
 *  conversationId. Clicking copies the artifacts:// URL for referencing in
 *  a message (the agent downloads content via its own tool). */
export function ConversationArtifactsPanel({ conversationId }: { conversationId: string }) {
  const [items, setItems] = useState<ArtifactMeta[]>([]);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    api
      .listArtifacts()
      .then((r) => {
        if (stopped) return;
        setItems((r.artifacts ?? []).filter((a) => a.source?.conversationId === conversationId));
      })
      .catch(() => {});
    return () => {
      stopped = true;
    };
  }, [conversationId]);

  if (items.length === 0) return null;

  return (
    <div className="mt-4 border-t border-(--hairline) pt-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-kicker text-(--mute)">
        <Package size={11} />
        会话产物 {items.length}
      </div>
      <div className="space-y-0.5">
        {items.map((a) => (
          <button
            key={a.url}
            title={`${a.url}（点击复制，可在消息中引用；agent 会自行下载内容）`}
            className="block w-full truncate rounded px-1.5 py-1 text-left font-mono text-[10px] text-(--info) hover:bg-(--panel2)"
            onClick={() => {
              void navigator.clipboard?.writeText(a.url);
              setCopied(a.url);
              setTimeout(() => setCopied(null), 1500);
            }}
          >
            {copied === a.url ? "已复制 ✓" : a.url}
          </button>
        ))}
      </div>
    </div>
  );
}
