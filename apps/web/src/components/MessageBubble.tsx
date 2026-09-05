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

/** `14:28:09` — strict turn timestamp from the message ledger. */
function fmtTime(ts: number | undefined): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** IM-style message shell: messages from the same sender group; only the first
 *  in a run carries the sender marker (a small coloured avatar dot, name shown
 *  on hover). The viewer's own messages never show a sender. The thinking
 *  toggle / inline details live INSIDE the body — they don't shift layout. */
export function MessageShell({
  align,
  name,
  kind,
  agentId,
  createdAt,
  isStreaming,
  showSender,
  isFirst,
  isLast,
  children,
}: {
  align: "left" | "right";
  name?: string;
  kind?: "agent" | "human";
  agentId?: string;
  createdAt?: number;
  isStreaming?: boolean;
  /** Only the group's first message renders the sender marker. */
  showSender?: boolean;
  /** Consecutive same-sender group bounds: first tightens the leading gap,
   *  last adds only the trailing timestamp. */
  isFirst?: boolean;
  isLast?: boolean;
  children: ReactNode;
}) {
  const isSelf = align === "right";
  const accent = !isSelf && kind === "agent" && agentId ? agentColor(agentId) : undefined;
  const senderLabel = name && kind !== "human" ? name : undefined;

  return (
    <div
      className={`flex gap-2.5 ${isSelf ? "justify-end" : "justify-start"} ${
        isFirst && !isSelf ? "mt-3" : isSelf && isFirst ? "mt-2" : ""
      }`}
    >
      {/* Sender marker — only the group's first agent message, and never for self */}
      {!isSelf && showSender && (
        <div
          className="group/avatar mt-1.5 flex size-6 shrink-0 cursor-default items-center justify-center rounded-full"
          style={
            accent
              ? {
                  backgroundColor: `color-mix(in srgb, ${accent} 26%, transparent)`,
                  color: accent,
                  boxShadow: `0 0 0 1px color-mix(in srgb, ${accent} 40%, transparent)`,
                }
              : { backgroundColor: "var(--panel2)", color: "var(--mute)" }
          }
          title={senderLabel ?? undefined}
          aria-hidden
        >
          <span className="hidden text-[9px] font-semibold group-hover/avatar:inline">
            {(senderLabel ?? "·").slice(0, 2).toUpperCase()}
          </span>
        </div>
      )}
      <div
        className={`flex min-w-0 flex-col ${isSelf ? "items-end" : "items-start"} ${
          isSelf ? "max-w-[85%]" : "max-w-[85%]"
        }`}
      >
        <div
          className={`min-w-0 w-full text-sm/relaxed ${isSelf ? "" : "font-sans"} ${
            isStreaming ? "border-l-2 pl-3" : ""
          }`}
          style={isStreaming && accent ? { borderColor: accent } : undefined}
        >
          {children}
        </div>
        {/* Trailing timestamp — only the last message of a sender's group */}
        {isLast && createdAt && (
          <span className="mt-1 font-code-sm text-code-sm text-(--faint) tabular-nums">
            {fmtTime(createdAt)}
          </span>
        )}
      </div>
    </div>
  );
}

export function MessageBubble({
  align,
  name,
  kind,
  agentId,
  createdAt,
  content,
  isStreaming,
  runStatus,
  state,
  error,
  showSender,
  isFirst,
  isLast,
}: {
  align: "left" | "right";
  name?: string;
  kind?: "agent" | "human";
  agentId?: string;
  createdAt?: number;
  content: string;
  isStreaming?: boolean;
  runStatus?: "running" | "retrying" | "compacting" | "waiting";
  state?: "pending" | "streaming" | "waiting" | "done" | "error";
  error?: string;
  showSender?: boolean;
  isFirst?: boolean;
  isLast?: boolean;
}) {
  const isSelf = align === "right";
  return (
    <MessageShell
      align={align}
      name={name}
      kind={kind}
      agentId={agentId}
      createdAt={createdAt}
      isStreaming={isStreaming}
      showSender={showSender}
      isFirst={isFirst}
      isLast={isLast}
    >
      {isSelf ? (
        <p className="whitespace-pre-wrap wrap-break-word text-(--ink) bg-(--panel2) rounded-lg px-3 py-2">
          {content}
        </p>
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
      {(state === "error" || error) && (
        <div
          data-testid="message-error"
          className="mt-2 px-3 py-2 rounded-md border border-(--err)/40 bg-(--err)/10 text-xs text-(--err) wrap-break-word"
        >
          {error ?? "Run failed"}
        </div>
      )}
    </MessageShell>
  );
}
