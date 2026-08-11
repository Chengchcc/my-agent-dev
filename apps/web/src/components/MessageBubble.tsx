import type { ReactNode } from "react";
import { StreamingCursor } from "./StreamingCursor";
import { StreamingMarkdown } from "./StreamingMarkdown";

/** Stable per-agent color derived from agentId (hash → hue). */
export function agentColor(agentId: string): string {
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = agentId.charCodeAt(i) + ((hash << 5) - hash);
  }
  return `hsl(${Math.abs(hash) % 360}, 65%, 50%)`;
}

/** Shared message shell: alignment + optional name badge + streaming border. */
export function MessageShell({
  align,
  name,
  kind,
  agentId,
  isStreaming,
  children,
}: {
  align: "left" | "right";
  name?: string;
  kind?: "agent" | "human";
  agentId?: string;
  isStreaming?: boolean;
  children: ReactNode;
}) {
  const isSelf = align === "right";
  // Per-agent color: agent messages use a hue derived from agentId; humans stay neutral.
  const accent = !isSelf && kind === "agent" && agentId ? agentColor(agentId) : undefined;
  return (
    <div className={`flex gap-4 py-2 ${isSelf ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[85%] ${isSelf ? "order-2" : ""}`}>
        {!isSelf && name && (
          <span
            className="text-[10px] tracking-[0.15em] uppercase mb-1.5 block font-sans font-semibold flex items-center gap-1.5"
            style={accent ? { color: accent } : undefined}
          >
            {accent && (
              <span
                className="inline-block size-2 rounded-full shrink-0"
                style={{ backgroundColor: accent }}
                aria-hidden
              />
            )}
            {name}
          </span>
        )}
        <div
          className={`text-sm/relaxed  ${isStreaming ? "border-l-2 pl-4" : ""}`}
          style={isStreaming && accent ? { borderColor: accent } : undefined}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

export function MessageBubble({
  align,
  name,
  kind,
  agentId,
  content,
  isStreaming,
  runStatus,
}: {
  align: "left" | "right";
  name?: string;
  kind?: "agent" | "human";
  agentId?: string;
  content: string;
  isStreaming?: boolean;
  runStatus?: "running" | "retrying" | "compacting" | "waiting";
}) {
  const isSelf = align === "right";
  return (
    <MessageShell align={align} name={name} kind={kind} agentId={agentId} isStreaming={isStreaming}>
      {isSelf ? (
        <p className="whitespace-pre-wrap wrap-break-word text-(--ink)">{content}</p>
      ) : (
        <>
          <StreamingMarkdown text={content} streaming={isStreaming ?? false} />
          {isStreaming && <StreamingCursor />}
        </>
      )}
      {runStatus === "retrying" && (
        <p className="text-xs text-amber-500 animate-pulse mt-1">Retrying...</p>
      )}
      {runStatus === "compacting" && (
        <p className="text-xs text-blue-500 animate-pulse mt-1">Compacting context...</p>
      )}
      {runStatus === "waiting" && (
        <p className="text-xs text-muted-foreground mt-1">Awaiting approval...</p>
      )}
    </MessageShell>
  );
}
