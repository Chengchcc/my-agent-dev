import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/* ── Obsidian Control Matrix page patterns ──
 * Shared building blocks for the redesign: every page (designed or deep)
 * composes from this kit so density and language stay consistent. */

/** Uppercase JetBrains micro-label — `STATUS: RUNNING` style. */
export function MonoLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "font-mono text-[10px] font-semibold uppercase tracking-kicker text-(--mute)",
        className,
      )}
    >
      {children}
    </span>
  );
}

export type StatusTone = "running" | "success" | "waiting" | "error" | "idle";

const STATUS_STYLE: Record<StatusTone, { dot: string; text: string }> = {
  running: { dot: "bg-(--primary) animate-dot-pulse", text: "text-(--primary)" },
  success: { dot: "bg-(--ok)", text: "text-(--ok)" },
  waiting: { dot: "bg-(--accent-violet)", text: "text-(--accent-violet)" },
  error: { dot: "bg-(--err)", text: "text-(--err)" },
  idle: { dot: "bg-(--faint)", text: "text-(--mute)" },
};

/** Execution status pill: tone dot + uppercase mono label. */
export function StatusPill({
  tone,
  children,
  className,
}: {
  tone: StatusTone;
  children: ReactNode;
  className?: string;
}) {
  const style = STATUS_STYLE[tone];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm border border-(--hairline) px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-kicker",
        style.text,
        className,
      )}
    >
      <span className={cn("size-1.5 rounded-full", style.dot)} />
      {children}
    </span>
  );
}

/** Compact metric tile (Obsidian design): mono micro-label, oversized tabular
 *  value, detail line, and an optional progress strip. */
export function KpiTile({
  label,
  value,
  detail,
  icon: Icon,
  bar,
  barTone = "primary",
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
  icon?: LucideIcon;
  /** 0–100 fill width for the progress strip. */
  bar?: number;
  barTone?: "primary" | "ok" | "violet" | "err";
  className?: string;
}) {
  const BAR_COLOR: Record<string, string> = {
    primary: "bg-(--primary)",
    ok: "bg-(--ok)",
    violet: "bg-(--accent-violet)",
    err: "bg-(--err)",
  };
  return (
    <div
      className={cn("rounded-lg border border-(--hairline) bg-(--panel) p-3 shadow-sm", className)}
    >
      <div className="flex items-center justify-between gap-2">
        <MonoLabel>{label}</MonoLabel>
        {Icon && <Icon className="size-4 shrink-0 text-(--primary)" />}
      </div>
      <span className="mt-1.5 block font-display text-2xl font-semibold tracking-tight text-(--ink-strong) tabular-nums">
        {value}
      </span>
      {detail && <span className="mt-0.5 block font-mono text-[10px] text-(--mute)">{detail}</span>}
      {typeof bar === "number" && (
        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-(--panel2)">
          <div
            className={cn("h-full rounded-full", BAR_COLOR[barTone])}
            style={{ width: `${Math.min(100, Math.max(0, bar))}%` }}
          />
        </div>
      )}
    </div>
  );
}
